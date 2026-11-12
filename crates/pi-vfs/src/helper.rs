//! Out-of-process Raw-I/O Helper client and worker loop for
//! [`crate::Fs::native`].
//!
//! POSIX advisory file locks (`fcntl(F_SETLK)`) are owned by `(process, inode)`
//! and are released on the first `close(2)` of *any* file descriptor for that
//! inode inside the same process. Routing [`crate::Fs::native`] file opens,
//! reads, writes, and copies through a long-lived child process over anonymous
//! OS byte pipes ensures `omp` never opens or closes a host file descriptor
//! in-process during embedded-shell redirects, builtin file opens, or native
//! search/walker reads.

use std::{
	collections::HashMap,
	ffi::OsStr,
	fmt,
	fs::{self, File},
	io::{self, BufReader, Read, Seek, SeekFrom, Write},
	os::{
		fd::FromRawFd,
		unix::{
			ffi::OsStrExt,
			fs::{MetadataExt, OpenOptionsExt},
		},
	},
	path::Path,
	process::{Child, ChildStdin, ChildStdout, Command, Stdio},
	sync::{
		Arc, LazyLock, Mutex,
		atomic::{AtomicBool, Ordering},
	},
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::{
	metadata::Metadata,
	native,
	options::OpenOptions,
	types::{FileId, FileTime, FileType, Permissions, StatFs},
};

/// Fault-injection environment variable for `pi-vfs` Raw-I/O Helper tests
/// (`spawn_fail` or `fail_after_ops:<N>`). Never accepts an executable path.
pub const RAW_IO_VFS_HELPER_FAULT_ENV: &str = "OMP_RAW_IO_VFS_HELPER_FAULT";

/// Hidden CLI flag that dispatches a spawned executable into
/// [`run_vfs_helper_loop`].
pub const RAW_IO_VFS_HELPER_FLAG: &str = "--omp-raw-io-helper";

const HANDSHAKE_MAGIC: &[u8; 4] = b"RWIO";

const OP_OPEN: u8 = 1;
const OP_CLONE: u8 = 2;
const OP_READ: u8 = 3;
const OP_WRITE: u8 = 4;
const OP_SEEK: u8 = 5;
const OP_METADATA: u8 = 6;
const OP_SET_LEN: u8 = 7;
const OP_SET_PERMISSIONS: u8 = 8;
const OP_SET_TIMES: u8 = 9;
const OP_SYNC: u8 = 10;
const OP_IS_LOCKED: u8 = 11;
const OP_FSTAT_FS: u8 = 12;
const OP_CLOSE: u8 = 13;
const OP_READ_ALL: u8 = 14;
const OP_WRITE_ALL: u8 = 15;
const OP_COPY: u8 = 16;

const STATUS_OK: u8 = 0;
const STATUS_ERR: u8 = 1;

const OPEN_READ: u8 = 1 << 0;
const OPEN_WRITE: u8 = 1 << 1;
const OPEN_APPEND: u8 = 1 << 2;
const OPEN_TRUNCATE: u8 = 1 << 3;
const OPEN_CREATE: u8 = 1 << 4;
const OPEN_CREATE_NEW: u8 = 1 << 5;
const OPEN_HAS_MODE: u8 = 1 << 6;
const OPEN_HAS_CUSTOM_FLAGS: u8 = 1 << 7;

const TIME_OMIT: u8 = 0;
const TIME_NOW: u8 = 1;
const TIME_AT: u8 = 2;

static IN_HELPER_PROCESS: AtomicBool = AtomicBool::new(false);

/// True when the current process is the Raw-I/O Helper child itself.
pub fn in_helper_process() -> bool {
	IN_HELPER_PROCESS.load(Ordering::Relaxed)
}

/// True when this process routes regular-file opens through the Raw-I/O Helper:
/// it is the omp process (the `.node` addon) and not the helper child itself.
/// The walker and the embedded shell ask this before opening a host file, so
/// plain Rust test binaries keep their direct opens.
pub fn routes_opens() -> bool {
	!in_helper_process() && module_is_node_addon()
}

/// Error wrapper marking a Raw-I/O Helper startup or transport failure so
/// callers (`grep`, `pi-walker`, embedded shell) never swallow it as an
/// ordinary skipped file.
#[derive(Debug)]
pub struct RawIoHelperFailure {
	message: String,
}

impl fmt::Display for RawIoHelperFailure {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str(&self.message)
	}
}

impl std::error::Error for RawIoHelperFailure {}

fn helper_failure_error(operation: &str, path: &Path, detail: impl fmt::Display) -> io::Error {
	io::Error::other(RawIoHelperFailure {
		message: format!("Raw-I/O Helper failed during {operation} for {}: {detail}", path.display()),
	})
}

fn target_os_error(operation: &str, path: &Path, raw_os_error: i32, message: &str) -> io::Error {
	let base = if raw_os_error != 0 {
		io::Error::from_raw_os_error(raw_os_error)
	} else {
		io::Error::other(message.to_owned())
	};
	io::Error::new(
		base.kind(),
		format!("Raw-I/O Helper {operation} failed for {}: {base}", path.display()),
	)
}

/// Returns `true` when `err` came from a Raw-I/O Helper startup or transport
/// failure rather than a normal filesystem condition (`ENOENT`, `EACCES`, ...).
pub fn is_raw_io_helper_failure(err: &io::Error) -> bool {
	err.get_ref()
		.is_some_and(|inner| inner.is::<RawIoHelperFailure>())
		|| err.to_string().starts_with("Raw-I/O Helper failed during ")
}

/// The first Raw-I/O Helper failure a shell redirect pump hit since
/// [`clear_stream_failure`]. A pump ends its stream at the first error, as a
/// closed pipe would, so the shell run checks this slot to fail the command
/// naming the operation and path (ERRORS-RAWIO-1b) instead of reporting
/// success.
static STREAM_FAILURE: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// Records `err` as the stream failure when it is a helper failure; other
/// errors are ignored.
pub fn record_stream_failure(err: &io::Error) {
	if is_raw_io_helper_failure(err) {
		STREAM_FAILURE
			.lock()
			.unwrap_or_else(std::sync::PoisonError::into_inner)
			.get_or_insert_with(|| err.to_string());
	}
}

/// Forgets any recorded stream failure; a shell run calls it before it starts.
pub fn clear_stream_failure() {
	*STREAM_FAILURE
		.lock()
		.unwrap_or_else(std::sync::PoisonError::into_inner) = None;
}

/// Takes the recorded stream failure, if any.
pub fn take_stream_failure() -> Option<String> {
	STREAM_FAILURE
		.lock()
		.unwrap_or_else(std::sync::PoisonError::into_inner)
		.take()
}

fn write_u8(w: &mut impl Write, v: u8) -> io::Result<()> {
	w.write_all(&[v])
}

fn write_u32(w: &mut impl Write, v: u32) -> io::Result<()> {
	w.write_all(&v.to_le_bytes())
}

fn write_i32(w: &mut impl Write, v: i32) -> io::Result<()> {
	w.write_all(&v.to_le_bytes())
}

fn write_u64(w: &mut impl Write, v: u64) -> io::Result<()> {
	w.write_all(&v.to_le_bytes())
}

fn write_i64(w: &mut impl Write, v: i64) -> io::Result<()> {
	w.write_all(&v.to_le_bytes())
}

fn write_bytes(w: &mut impl Write, bytes: &[u8]) -> io::Result<()> {
	let len = u32::try_from(bytes.len())
		.map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "frame payload too large"))?;
	write_u32(w, len)?;
	w.write_all(bytes)
}

fn write_path(w: &mut impl Write, path: &Path) -> io::Result<()> {
	write_bytes(w, path.as_os_str().as_bytes())
}

fn read_u8(r: &mut impl Read) -> io::Result<u8> {
	let mut buf = [0u8; 1];
	r.read_exact(&mut buf)?;
	Ok(buf[0])
}

fn read_u32(r: &mut impl Read) -> io::Result<u32> {
	let mut buf = [0u8; 4];
	r.read_exact(&mut buf)?;
	Ok(u32::from_le_bytes(buf))
}

fn read_i32(r: &mut impl Read) -> io::Result<i32> {
	let mut buf = [0u8; 4];
	r.read_exact(&mut buf)?;
	Ok(i32::from_le_bytes(buf))
}

fn read_u64(r: &mut impl Read) -> io::Result<u64> {
	let mut buf = [0u8; 8];
	r.read_exact(&mut buf)?;
	Ok(u64::from_le_bytes(buf))
}

fn read_i64(r: &mut impl Read) -> io::Result<i64> {
	let mut buf = [0u8; 8];
	r.read_exact(&mut buf)?;
	Ok(i64::from_le_bytes(buf))
}

fn read_bytes(r: &mut impl Read) -> io::Result<Vec<u8>> {
	let len = read_u32(r)? as usize;
	let mut buf = vec![0u8; len];
	r.read_exact(&mut buf)?;
	Ok(buf)
}

fn split_system_time(time: SystemTime) -> (i64, u32) {
	match time.duration_since(UNIX_EPOCH) {
		Ok(after) => (after.as_secs() as i64, after.subsec_nanos()),
		Err(before) => {
			let d = before.duration();
			let secs = -(d.as_secs() as i64);
			match d.subsec_nanos() {
				0 => (secs, 0),
				nanos => (secs - 1, 1_000_000_000 - nanos),
			}
		},
	}
}

fn decode_system_time(secs: i64, nanos: u32) -> SystemTime {
	let nanos = nanos.min(999_999_999);
	if secs >= 0 {
		UNIX_EPOCH + Duration::new(secs as u64, nanos)
	} else {
		UNIX_EPOCH - Duration::from_secs(secs.unsigned_abs()) + Duration::from_nanos(u64::from(nanos))
	}
}

fn write_opt_time(w: &mut impl Write, time: Option<SystemTime>) -> io::Result<()> {
	match time {
		Some(t) => {
			let (secs, nanos) = split_system_time(t);
			write_u8(w, 1)?;
			write_i64(w, secs)?;
			write_u32(w, nanos)
		},
		None => write_u8(w, 0),
	}
}

fn read_opt_time(r: &mut impl Read) -> io::Result<Option<SystemTime>> {
	match read_u8(r)? {
		0 => Ok(None),
		_ => {
			let secs = read_i64(r)?;
			let nanos = read_u32(r)?;
			Ok(Some(decode_system_time(secs, nanos)))
		},
	}
}

fn write_file_time(w: &mut impl Write, time: FileTime) -> io::Result<()> {
	match time {
		FileTime::Omit => write_u8(w, TIME_OMIT),
		FileTime::Now => write_u8(w, TIME_NOW),
		FileTime::At(t) => {
			let (secs, nanos) = split_system_time(t);
			write_u8(w, TIME_AT)?;
			write_i64(w, secs)?;
			write_u32(w, nanos)
		},
	}
}

fn read_file_time(r: &mut impl Read) -> io::Result<FileTime> {
	match read_u8(r)? {
		TIME_OMIT => Ok(FileTime::Omit),
		TIME_NOW => Ok(FileTime::Now),
		_ => {
			let secs = read_i64(r)?;
			let nanos = read_u32(r)?;
			Ok(FileTime::At(decode_system_time(secs, nanos)))
		},
	}
}

fn write_metadata(w: &mut impl Write, meta: &fs::Metadata) -> io::Result<()> {
	write_u32(w, meta.mode())?;
	write_u64(w, meta.len())?;
	write_opt_time(w, meta.modified().ok())?;
	write_opt_time(w, meta.accessed().ok())?;
	write_opt_time(w, meta.created().ok())?;
	let ctime_nanos = u32::try_from(meta.ctime_nsec().clamp(0, 999_999_999)).unwrap_or(0);
	write_i64(w, meta.ctime())?;
	write_u32(w, ctime_nanos)?;
	write_u64(w, meta.dev())?;
	write_u64(w, meta.ino())?;
	write_u64(w, meta.nlink())?;
	write_u32(w, meta.uid())?;
	write_u32(w, meta.gid())?;
	write_u64(w, meta.rdev())?;
	write_u64(w, meta.blocks())?;
	write_u64(w, meta.blksize())
}

fn read_metadata(r: &mut impl Read) -> io::Result<Metadata> {
	let mode = read_u32(r)?;
	let len = read_u64(r)?;
	let modified = read_opt_time(r)?;
	let accessed = read_opt_time(r)?;
	let created = read_opt_time(r)?;
	let ctime_secs = read_i64(r)?;
	let ctime_nanos = read_u32(r)?;
	let dev = read_u64(r)?;
	let ino = read_u64(r)?;
	let nlink = read_u64(r)?;
	let uid = read_u32(r)?;
	let gid = read_u32(r)?;
	let rdev = read_u64(r)?;
	let blocks = read_u64(r)?;
	let blksize = read_u64(r)?;

	let mut metadata =
		Metadata::new(FileType::from_mode(mode), len, Permissions::from_mode(mode & 0o7777))
			.with_changed(decode_system_time(ctime_secs, ctime_nanos))
			.with_native_id(dev, ino)
			.with_nlink(nlink)
			.with_owner(uid, gid)
			.with_rdev(rdev)
			.with_blocks(blocks, blksize);
	if let Some(t) = modified {
		metadata = metadata.with_modified(t);
	}
	if let Some(t) = accessed {
		metadata = metadata.with_accessed(t);
	}
	if let Some(t) = created {
		metadata = metadata.with_created(t);
	}
	Ok(metadata)
}

fn write_stat_fs(w: &mut impl Write, stat: &StatFs) -> io::Result<()> {
	match stat.fs_type {
		Some(v) => {
			write_u8(w, 1)?;
			write_i64(w, v)?;
		},
		None => write_u8(w, 0)?,
	}
	match &stat.fs_type_name {
		Some(name) => {
			write_u8(w, 1)?;
			write_bytes(w, name.as_bytes())?;
		},
		None => write_u8(w, 0)?,
	}
	write_u64(w, stat.block_size)?;
	write_u64(w, stat.io_size)?;
	write_u64(w, stat.blocks)?;
	write_u64(w, stat.blocks_free)?;
	write_u64(w, stat.blocks_available)?;
	write_u64(w, stat.files)?;
	write_u64(w, stat.files_free)?;
	match stat.fsid {
		Some(v) => {
			write_u8(w, 1)?;
			write_u64(w, v)?;
		},
		None => write_u8(w, 0)?,
	}
	match stat.name_max {
		Some(v) => {
			write_u8(w, 1)?;
			write_u64(w, v)?;
		},
		None => write_u8(w, 0)?,
	}
	Ok(())
}

fn read_stat_fs(r: &mut impl Read) -> io::Result<StatFs> {
	let fs_type = if read_u8(r)? != 0 {
		Some(read_i64(r)?)
	} else {
		None
	};
	let fs_type_name = if read_u8(r)? != 0 {
		Some(String::from_utf8_lossy(&read_bytes(r)?).into_owned())
	} else {
		None
	};
	let block_size = read_u64(r)?;
	let io_size = read_u64(r)?;
	let blocks = read_u64(r)?;
	let blocks_free = read_u64(r)?;
	let blocks_available = read_u64(r)?;
	let files = read_u64(r)?;
	let files_free = read_u64(r)?;
	let fsid = if read_u8(r)? != 0 {
		Some(read_u64(r)?)
	} else {
		None
	};
	let name_max = if read_u8(r)? != 0 {
		Some(read_u64(r)?)
	} else {
		None
	};
	Ok(StatFs {
		fs_type,
		fs_type_name,
		block_size,
		io_size,
		blocks,
		blocks_free,
		blocks_available,
		files,
		files_free,
		fsid,
		name_max,
	})
}

fn write_err(w: &mut impl Write, err: &io::Error) -> io::Result<()> {
	write_u8(w, STATUS_ERR)?;
	write_i32(w, err.raw_os_error().unwrap_or(0))?;
	write_bytes(w, err.to_string().as_bytes())
}

fn resolve_current_module_path() -> Option<std::path::PathBuf> {
	// SAFETY: `Dl_info` is a plain C output struct written by `dladdr`.
	let mut info: libc::Dl_info = unsafe { std::mem::zeroed() };
	let rc = unsafe {
		libc::dladdr(resolve_current_module_path as *const () as *const libc::c_void, &raw mut info)
	};
	if rc == 0 || info.dli_fname.is_null() {
		return None;
	}
	// SAFETY: `dli_fname` is a NUL-terminated C string from the dynamic linker.
	let bytes = unsafe { std::ffi::CStr::from_ptr(info.dli_fname) }.to_bytes();
	if bytes.is_empty() {
		return None;
	}
	let raw = std::path::PathBuf::from(OsStr::from_bytes(bytes));
	if raw.is_absolute() {
		Some(raw)
	} else {
		std::env::current_dir().ok().map(|cwd| cwd.join(raw))
	}
}

static MODULE_PATH: LazyLock<Option<std::path::PathBuf>> =
	LazyLock::new(resolve_current_module_path);

fn module_is_node_addon() -> bool {
	MODULE_PATH
		.as_deref()
		.and_then(Path::extension)
		.is_some_and(|ext| ext == "node")
}

/// Called by the native addon loader (`__ompInstallTokioRuntime`) right after
/// `dlopen` returns. Caches the `.node` path while the initial working
/// directory is still intact, and enters [`run_vfs_helper_loop`] when this
/// process was spawned as the `pi-vfs` Raw-I/O Helper child.
pub fn init_vfs_helper_host() {
	let _ = &*MODULE_PATH;
	if std::env::var_os(RAW_IO_VFS_HELPER_FLAG).is_some_and(|v| v == "1") {
		run_vfs_helper_loop();
	}
}

#[cfg(any(target_os = "linux", target_vendor = "apple"))]
extern "C" fn maybe_enter_vfs_helper_on_startup() {
	if !module_is_node_addon() && std::env::var_os(RAW_IO_VFS_HELPER_FLAG).is_some_and(|v| v == "1")
	{
		run_vfs_helper_loop();
	}
}

#[cfg(target_os = "linux")]
#[used]
#[unsafe(link_section = ".init_array")]
static VFS_HELPER_CTOR: extern "C" fn() = maybe_enter_vfs_helper_on_startup;

#[cfg(target_vendor = "apple")]
#[used]
#[unsafe(link_section = "__DATA,__mod_init_func")]
static VFS_HELPER_CTOR: extern "C" fn() = maybe_enter_vfs_helper_on_startup;

/// Runs the synchronous Raw-I/O Helper loop on stdin/stdout until EOF, then
/// exits the helper process.
pub fn run_vfs_helper_loop() -> ! {
	IN_HELPER_PROCESS.store(true, Ordering::SeqCst);
	// SAFETY: helper runs single-threaded before any user work; clear bootstrap
	// env vars.
	let mut remaining_ops = std::env::var(RAW_IO_VFS_HELPER_FAULT_ENV)
		.ok()
		.and_then(|val| val.strip_prefix("fail_after_ops:")?.parse::<usize>().ok());
    // Avoid mutating process-wide environment variables to prevent data races under multi-threaded tokio workers.
	// Duplicate stdout for the framing channel and redirect fd 1 to /dev/null
	// so any accidental stdout print inside the child cannot corrupt the pipe.
	let protocol_out_fd = unsafe { libc::dup(libc::STDOUT_FILENO) };
	if protocol_out_fd < 0 {
		std::process::exit(2);
	}
	if let Ok(devnull) = fs::OpenOptions::new().write(true).open("/dev/null") {
		use std::os::fd::AsRawFd;
		unsafe {
			libc::dup2(devnull.as_raw_fd(), libc::STDOUT_FILENO);
		}
	}
	// SAFETY: `protocol_out_fd` was just created by `dup`.
	let mut out = unsafe { File::from_raw_fd(protocol_out_fd) };
	let stdin = io::stdin();
	let mut inp = BufReader::new(stdin.lock());

	if out.write_all(HANDSHAKE_MAGIC).is_err()
		|| write_u32(&mut out, std::process::id()).is_err()
		|| out.flush().is_err()
	{
		std::process::exit(0);
	}

	let mut handles: HashMap<u64, File> = HashMap::new();
	let mut next_id: u64 = 1;

	while let Ok(op) = read_u8(&mut inp) {
		if let Some(rem) = &mut remaining_ops {
			if *rem == 0 {
				std::process::exit(2);
			}
			*rem -= 1;
		}
		let step: io::Result<()> = (|| {
			match op {
				OP_OPEN => {
					let path_bytes = read_bytes(&mut inp)?;
					let flags = read_u8(&mut inp)?;
					let mode = if flags & OPEN_HAS_MODE != 0 {
						Some(read_u32(&mut inp)?)
					} else {
						None
					};
					let custom_flags = if flags & OPEN_HAS_CUSTOM_FLAGS != 0 {
						read_i32(&mut inp)?
					} else {
						0
					};
					let path = Path::new(OsStr::from_bytes(&path_bytes));
					let mut opts = fs::OpenOptions::new();
					opts
						.read(flags & OPEN_READ != 0)
						.write(flags & OPEN_WRITE != 0)
						.append(flags & OPEN_APPEND != 0)
						.truncate(flags & OPEN_TRUNCATE != 0)
						.create(flags & OPEN_CREATE != 0)
						.create_new(flags & OPEN_CREATE_NEW != 0);
					if let Some(m) = mode {
						opts.mode(m);
					}
					if custom_flags != 0 {
						opts.custom_flags(custom_flags);
					}
					match opts.open(path) {
						Ok(file) => {
							let id = next_id;
							next_id = next_id.wrapping_add(1).max(1);
							handles.insert(id, file);
							write_u8(&mut out, STATUS_OK)?;
							write_u64(&mut out, id)?;
						},
						Err(err) => write_err(&mut out, &err)?,
					}
				},
				OP_CLONE => {
					let id = read_u64(&mut inp)?;
					let res = match handles.get(&id) {
						Some(file) => file.try_clone(),
						None => Err(io::Error::from_raw_os_error(libc::EBADF)),
					};
					match res {
						Ok(cloned) => {
							let new_id = next_id;
							next_id = next_id.wrapping_add(1).max(1);
							handles.insert(new_id, cloned);
							write_u8(&mut out, STATUS_OK)?;
							write_u64(&mut out, new_id)?;
						},
						Err(err) => write_err(&mut out, &err)?,
					}
				},
				OP_READ => {
					let id = read_u64(&mut inp)?;
					let len = (read_u32(&mut inp)? as usize).min(4 * 1024 * 1024);
					let mut buf = vec![0u8; len];
					let res = match handles.get_mut(&id) {
						Some(file) => file.read(&mut buf),
						None => Err(io::Error::from_raw_os_error(libc::EBADF)),
					};
					match res {
						Ok(n) => {
							write_u8(&mut out, STATUS_OK)?;
							write_bytes(&mut out, &buf[..n])?;
						},
						Err(err) => write_err(&mut out, &err)?,
					}
				},
				OP_WRITE => {
					let id = read_u64(&mut inp)?;
					let data = read_bytes(&mut inp)?;
					let res = match handles.get_mut(&id) {
						Some(file) => file.write(&data),
						None => Err(io::Error::from_raw_os_error(libc::EBADF)),
					};
					match res {
						Ok(n) => {
							write_u8(&mut out, STATUS_OK)?;
							write_u32(&mut out, u32::try_from(n).unwrap_or(u32::MAX))?;
						},
						Err(err) => write_err(&mut out, &err)?,
					}
				},
				OP_SEEK => {
					let id = read_u64(&mut inp)?;
					let kind = read_u8(&mut inp)?;
					let offset = read_i64(&mut inp)?;
					let pos = match kind {
						0 => SeekFrom::Start(offset.max(0) as u64),
						1 => SeekFrom::End(offset),
						_ => SeekFrom::Current(offset),
					};
					let res = match handles.get_mut(&id) {
						Some(file) => file.seek(pos),
						None => Err(io::Error::from_raw_os_error(libc::EBADF)),
					};
					match res {
						Ok(new_pos) => {
							write_u8(&mut out, STATUS_OK)?;
							write_u64(&mut out, new_pos)?;
						},
						Err(err) => write_err(&mut out, &err)?,
					}
				},
				OP_METADATA => {
					let id = read_u64(&mut inp)?;
					let res = match handles.get(&id) {
						Some(file) => file.metadata(),
						None => Err(io::Error::from_raw_os_error(libc::EBADF)),
					};
					match res {
						Ok(meta) => {
							write_u8(&mut out, STATUS_OK)?;
							write_metadata(&mut out, &meta)?;
						},
						Err(err) => write_err(&mut out, &err)?,
					}
				},
				OP_SET_LEN => {
					let id = read_u64(&mut inp)?;
					let size = read_u64(&mut inp)?;
					let res = match handles.get(&id) {
						Some(file) => file.set_len(size),
						None => Err(io::Error::from_raw_os_error(libc::EBADF)),
					};
					match res {
						Ok(()) => write_u8(&mut out, STATUS_OK)?,
						Err(err) => write_err(&mut out, &err)?,
					}
				},
				OP_SET_PERMISSIONS => {
					let id = read_u64(&mut inp)?;
					let mode = read_u32(&mut inp)?;
					let res = match handles.get(&id) {
						Some(file) => native::file_set_permissions(file, Permissions::from_mode(mode)),
						None => Err(io::Error::from_raw_os_error(libc::EBADF)),
					};
					match res {
						Ok(()) => write_u8(&mut out, STATUS_OK)?,
						Err(err) => write_err(&mut out, &err)?,
					}
				},
				OP_SET_TIMES => {
					let id = read_u64(&mut inp)?;
					let accessed = read_file_time(&mut inp)?;
					let modified = read_file_time(&mut inp)?;
					let res = match handles.get(&id) {
						Some(file) => native::file_set_times(file, accessed, modified),
						None => Err(io::Error::from_raw_os_error(libc::EBADF)),
					};
					match res {
						Ok(()) => write_u8(&mut out, STATUS_OK)?,
						Err(err) => write_err(&mut out, &err)?,
					}
				},
				OP_SYNC => {
					let id = read_u64(&mut inp)?;
					let data_only = read_u8(&mut inp)? != 0;
					let res = match handles.get(&id) {
						Some(file) if data_only => file.sync_data(),
						Some(file) => file.sync_all(),
						None => Err(io::Error::from_raw_os_error(libc::EBADF)),
					};
					match res {
						Ok(()) => write_u8(&mut out, STATUS_OK)?,
						Err(err) => write_err(&mut out, &err)?,
					}
				},
				OP_IS_LOCKED => {
					let id = read_u64(&mut inp)?;
					let res = match handles.get(&id) {
						Some(file) => native::file_is_locked(file),
						None => Err(io::Error::from_raw_os_error(libc::EBADF)),
					};
					match res {
						Ok(locked) => {
							write_u8(&mut out, STATUS_OK)?;
							write_u8(&mut out, u8::from(locked))?;
						},
						Err(err) => write_err(&mut out, &err)?,
					}
				},
				OP_FSTAT_FS => {
					let id = read_u64(&mut inp)?;
					let res = match handles.get(&id) {
						Some(file) => native::fstat_fs(file),
						None => Err(io::Error::from_raw_os_error(libc::EBADF)),
					};
					match res {
						Ok(stat) => {
							write_u8(&mut out, STATUS_OK)?;
							write_stat_fs(&mut out, &stat)?;
						},
						Err(err) => write_err(&mut out, &err)?,
					}
				},
				OP_CLOSE => {
					let id = read_u64(&mut inp)?;
					let res = match handles.remove(&id) {
						Some(file) => native::close(file),
						None => Ok(()),
					};
					match res {
						Ok(()) => write_u8(&mut out, STATUS_OK)?,
						Err(err) => write_err(&mut out, &err)?,
					}
				},
				OP_READ_ALL => {
					let path_bytes = read_bytes(&mut inp)?;
					let path = Path::new(OsStr::from_bytes(&path_bytes));
					match fs::read(path) {
						Ok(bytes) => {
							write_u8(&mut out, STATUS_OK)?;
							write_bytes(&mut out, &bytes)?;
						},
						Err(err) => write_err(&mut out, &err)?,
					}
				},
				OP_WRITE_ALL => {
					let path_bytes = read_bytes(&mut inp)?;
					let data = read_bytes(&mut inp)?;
					let path = Path::new(OsStr::from_bytes(&path_bytes));
					match fs::write(path, &data) {
						Ok(()) => write_u8(&mut out, STATUS_OK)?,
						Err(err) => write_err(&mut out, &err)?,
					}
				},
				OP_COPY => {
					let from_bytes = read_bytes(&mut inp)?;
					let to_bytes = read_bytes(&mut inp)?;
					let from = Path::new(OsStr::from_bytes(&from_bytes));
					let to = Path::new(OsStr::from_bytes(&to_bytes));
					match fs::copy(from, to) {
						Ok(copied) => {
							write_u8(&mut out, STATUS_OK)?;
							write_u64(&mut out, copied)?;
						},
						Err(err) => write_err(&mut out, &err)?,
					}
				},
				_ => return Err(io::Error::new(io::ErrorKind::InvalidData, "unknown helper op")),
			}
			out.flush()
		})();
		if step.is_err() {
			break;
		}
	}
	drop(handles);
	std::process::exit(0);
}

struct HelperConn {
	child:      Child,
	stdin:      ChildStdin,
	stdout:     BufReader<ChildStdout>,
	helper_pid: u32,
}

impl HelperConn {
	fn spawn() -> Result<Self, String> {
		if std::env::var(RAW_IO_VFS_HELPER_FAULT_ENV)
			.ok()
			.is_some_and(|val| val == "spawn_fail" || val == "1")
		{
			return Err(
				"fault injection: helper spawn failed (OMP_RAW_IO_VFS_HELPER_FAULT=spawn_fail)"
					.to_owned(),
			);
		}
		let exe = std::env::current_exe().map_err(|err| format!("current_exe failed: {err}"))?;
		let mut cmd = Command::new(&exe);
		cmd.env(RAW_IO_VFS_HELPER_FLAG, "1");
		if module_is_node_addon()
			&& let Some(addon_path) = MODULE_PATH.as_deref()
		{
			cmd.env("BUN_BE_BUN", "1")
				.env("__OMP_VFS_HELPER_ADDON", addon_path)
				.arg("-e")
				.arg("require(process.env.__OMP_VFS_HELPER_ADDON).__ompInstallTokioRuntime()");
		} else {
			cmd.arg(RAW_IO_VFS_HELPER_FLAG);
		}

		cmd.stdin(Stdio::piped())
			.stdout(Stdio::piped())
			.stderr(Stdio::inherit());

		let mut child = cmd.spawn().map_err(|err| format!("spawn failed: {err}"))?;
		let stdin = child
			.stdin
			.take()
			.ok_or_else(|| "missing helper stdin pipe".to_owned())?;
		let stdout = child
			.stdout
			.take()
			.ok_or_else(|| "missing helper stdout pipe".to_owned())?;
		let mut stdout = BufReader::new(stdout);

		// Read until HANDSHAKE_MAGIC (skipping any stray startup bytes before the
		// helper loop took over stdout).
		let mut matched = 0usize;
		let mut scanned = 0usize;
		while matched < HANDSHAKE_MAGIC.len() {
			let b = read_u8(&mut stdout).map_err(|err| {
				let _ = child.kill();
				let _ = child.wait();
				format!("helper exited before handshake: {err}")
			})?;
			scanned += 1;
			if scanned > 65536 {
				let _ = child.kill();
				let _ = child.wait();
				return Err("helper handshake magic not found".to_owned());
			}
			if b == HANDSHAKE_MAGIC[matched] {
				matched += 1;
			} else if b == HANDSHAKE_MAGIC[0] {
				matched = 1;
			} else {
				matched = 0;
			}
		}
		let helper_pid = read_u32(&mut stdout).map_err(|err| {
			let _ = child.kill();
			let _ = child.wait();
			format!("helper pid handshake failed: {err}")
		})?;
		if helper_pid == 0 || helper_pid == std::process::id() {
			let _ = child.kill();
			let _ = child.wait();
			return Err(format!("invalid helper pid {helper_pid}"));
		}
		Ok(Self { child, stdin, stdout, helper_pid })
	}

	fn read_status(
		&mut self,
		operation: &str,
		path: &Path,
	) -> Result<Result<(), io::Error>, String> {
		let status = read_u8(&mut self.stdout).map_err(|err| err.to_string())?;
		if status == STATUS_OK {
			Ok(Ok(()))
		} else {
			let code = read_i32(&mut self.stdout).map_err(|err| err.to_string())?;
			let msg_bytes = read_bytes(&mut self.stdout).map_err(|err| err.to_string())?;
			let msg = String::from_utf8_lossy(&msg_bytes);
			Ok(Err(target_os_error(operation, path, code, &msg)))
		}
	}
}

impl Drop for HelperConn {
	fn drop(&mut self) {
		let _ = self.child.kill();
		let _ = self.child.wait();
	}
}

static HELPER_CONN: LazyLock<Mutex<Option<HelperConn>>> = LazyLock::new(|| Mutex::new(None));

fn with_helper<T>(
	operation: &str,
	path: &Path,
	f: impl FnOnce(&mut HelperConn) -> Result<io::Result<T>, String>,
) -> io::Result<T> {
	let mut guard = HELPER_CONN
		.lock()
		.unwrap_or_else(std::sync::PoisonError::into_inner);
	if guard.is_none() {
		match HelperConn::spawn() {
			Ok(conn) => *guard = Some(conn),
			Err(detail) => return Err(helper_failure_error(operation, path, detail)),
		}
	}
	let conn = guard.as_mut().expect("helper initialized");
	match f(conn) {
		Ok(result) => result,
		Err(transport_err) => {
			*guard = None;
			Err(helper_failure_error(operation, path, transport_err))
		},
	}
}

/// Returns the PID of the active `pi-vfs` Raw-I/O Helper child process, if
/// started.
pub fn helper_pid() -> Option<u32> {
	let guard = HELPER_CONN
		.lock()
		.unwrap_or_else(std::sync::PoisonError::into_inner);
	guard.as_ref().map(|c| c.helper_pid)
}

/// A host file opened inside the Raw-I/O Helper child process.
#[derive(Clone, Debug)]
pub struct HelperFile {
	handle_id: u64,
	path:      Arc<Path>,
}

impl HelperFile {
	pub fn open(path: &Path, options: &OpenOptions) -> io::Result<Self> {
		let mut flags = 0u8;
		if options.is_read() {
			flags |= OPEN_READ;
		}
		if options.is_write() {
			flags |= OPEN_WRITE;
		}
		if options.is_append() {
			flags |= OPEN_APPEND;
		}
		if options.is_truncate() {
			flags |= OPEN_TRUNCATE;
		}
		if options.is_create() {
			flags |= OPEN_CREATE;
		}
		if options.is_create_new() {
			flags |= OPEN_CREATE_NEW;
		}
		if options.get_mode().is_some() {
			flags |= OPEN_HAS_MODE;
		}
		if options.get_custom_flags() != 0 {
			flags |= OPEN_HAS_CUSTOM_FLAGS;
		}
		let handle_id = with_helper("open", path, |conn| {
			write_u8(&mut conn.stdin, OP_OPEN).map_err(|e| e.to_string())?;
			write_path(&mut conn.stdin, path).map_err(|e| e.to_string())?;
			write_u8(&mut conn.stdin, flags).map_err(|e| e.to_string())?;
			if let Some(mode) = options.get_mode() {
				write_u32(&mut conn.stdin, mode).map_err(|e| e.to_string())?;
			}
			if options.get_custom_flags() != 0 {
				write_i32(&mut conn.stdin, options.get_custom_flags()).map_err(|e| e.to_string())?;
			}
			conn.stdin.flush().map_err(|e| e.to_string())?;
			match conn.read_status("open", path)? {
				Ok(()) => Ok(Ok(read_u64(&mut conn.stdout).map_err(|e| e.to_string())?)),
				Err(err) => Ok(Err(err)),
			}
		})?;
		Ok(Self { handle_id, path: Arc::from(path) })
	}

	pub fn try_clone(&self) -> io::Result<Self> {
		let path = &self.path;
		let new_id = with_helper("clone", path, |conn| {
			write_u8(&mut conn.stdin, OP_CLONE).map_err(|e| e.to_string())?;
			write_u64(&mut conn.stdin, self.handle_id).map_err(|e| e.to_string())?;
			conn.stdin.flush().map_err(|e| e.to_string())?;
			match conn.read_status("clone", path)? {
				Ok(()) => Ok(Ok(read_u64(&mut conn.stdout).map_err(|e| e.to_string())?)),
				Err(err) => Ok(Err(err)),
			}
		})?;
		Ok(Self { handle_id: new_id, path: Arc::clone(&self.path) })
	}

	pub fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
		if buf.is_empty() {
			return Ok(0);
		}
		let req_len = u32::try_from(buf.len().min(4 * 1024 * 1024)).unwrap_or(4 * 1024 * 1024);
		let path = &self.path;
		let bytes = with_helper("read", path, |conn| {
			write_u8(&mut conn.stdin, OP_READ).map_err(|e| e.to_string())?;
			write_u64(&mut conn.stdin, self.handle_id).map_err(|e| e.to_string())?;
			write_u32(&mut conn.stdin, req_len).map_err(|e| e.to_string())?;
			conn.stdin.flush().map_err(|e| e.to_string())?;
			match conn.read_status("read", path)? {
				Ok(()) => Ok(Ok(read_bytes(&mut conn.stdout).map_err(|e| e.to_string())?)),
				Err(err) => Ok(Err(err)),
			}
		})?;
		let n = bytes.len().min(buf.len());
		buf[..n].copy_from_slice(&bytes[..n]);
		Ok(n)
	}

	pub fn read_to_end(&self, buf: &mut Vec<u8>) -> io::Result<usize> {
		let start = buf.len();
		let mut chunk = vec![0u8; 64 * 1024];
		loop {
			match self.read(&mut chunk) {
				Ok(0) => return Ok(buf.len() - start),
				Ok(n) => buf.extend_from_slice(&chunk[..n]),
				Err(err) if err.kind() == io::ErrorKind::Interrupted => {},
				Err(err) => return Err(err),
			}
		}
	}

	pub fn write(&self, buf: &[u8]) -> io::Result<usize> {
		if buf.is_empty() {
			return Ok(0);
		}
		let chunk = &buf[..buf.len().min(4 * 1024 * 1024)];
		let path = &self.path;
		let written = with_helper("write", path, |conn| {
			write_u8(&mut conn.stdin, OP_WRITE).map_err(|e| e.to_string())?;
			write_u64(&mut conn.stdin, self.handle_id).map_err(|e| e.to_string())?;
			write_bytes(&mut conn.stdin, chunk).map_err(|e| e.to_string())?;
			conn.stdin.flush().map_err(|e| e.to_string())?;
			match conn.read_status("write", path)? {
				Ok(()) => Ok(Ok(read_u32(&mut conn.stdout).map_err(|e| e.to_string())? as usize)),
				Err(err) => Ok(Err(err)),
			}
		})?;
		Ok(written)
	}

	pub fn write_all(&self, mut buf: &[u8]) -> io::Result<()> {
		while !buf.is_empty() {
			match self.write(buf) {
				Ok(0) => {
					return Err(io::Error::new(
						io::ErrorKind::WriteZero,
						"failed to write whole buffer",
					));
				},
				Ok(n) => buf = &buf[n..],
				Err(err) if err.kind() == io::ErrorKind::Interrupted => {},
				Err(err) => return Err(err),
			}
		}
		Ok(())
	}

	pub fn seek(&self, pos: SeekFrom) -> io::Result<u64> {
		let (kind, offset) = match pos {
			SeekFrom::Start(n) => (0u8, i64::try_from(n).unwrap_or(i64::MAX)),
			SeekFrom::End(n) => (1u8, n),
			SeekFrom::Current(n) => (2u8, n),
		};
		let path = &self.path;
		with_helper("seek", path, |conn| {
			write_u8(&mut conn.stdin, OP_SEEK).map_err(|e| e.to_string())?;
			write_u64(&mut conn.stdin, self.handle_id).map_err(|e| e.to_string())?;
			write_u8(&mut conn.stdin, kind).map_err(|e| e.to_string())?;
			write_i64(&mut conn.stdin, offset).map_err(|e| e.to_string())?;
			conn.stdin.flush().map_err(|e| e.to_string())?;
			match conn.read_status("seek", path)? {
				Ok(()) => Ok(Ok(read_u64(&mut conn.stdout).map_err(|e| e.to_string())?)),
				Err(err) => Ok(Err(err)),
			}
		})
	}

	pub fn metadata(&self) -> io::Result<Metadata> {
		let path = &self.path;
		with_helper("metadata", path, |conn| {
			write_u8(&mut conn.stdin, OP_METADATA).map_err(|e| e.to_string())?;
			write_u64(&mut conn.stdin, self.handle_id).map_err(|e| e.to_string())?;
			conn.stdin.flush().map_err(|e| e.to_string())?;
			match conn.read_status("metadata", path)? {
				Ok(()) => Ok(Ok(read_metadata(&mut conn.stdout).map_err(|e| e.to_string())?)),
				Err(err) => Ok(Err(err)),
			}
		})
	}

	pub fn set_len(&self, size: u64) -> io::Result<()> {
		let path = &self.path;
		with_helper("set_len", path, |conn| {
			write_u8(&mut conn.stdin, OP_SET_LEN).map_err(|e| e.to_string())?;
			write_u64(&mut conn.stdin, self.handle_id).map_err(|e| e.to_string())?;
			write_u64(&mut conn.stdin, size).map_err(|e| e.to_string())?;
			conn.stdin.flush().map_err(|e| e.to_string())?;
			conn.read_status("set_len", path)
		})
	}

	pub fn set_permissions(&self, permissions: Permissions) -> io::Result<()> {
		let path = &self.path;
		with_helper("set_permissions", path, |conn| {
			write_u8(&mut conn.stdin, OP_SET_PERMISSIONS).map_err(|e| e.to_string())?;
			write_u64(&mut conn.stdin, self.handle_id).map_err(|e| e.to_string())?;
			write_u32(&mut conn.stdin, permissions.mode()).map_err(|e| e.to_string())?;
			conn.stdin.flush().map_err(|e| e.to_string())?;
			conn.read_status("set_permissions", path)
		})
	}

	pub fn set_times(&self, accessed: FileTime, modified: FileTime) -> io::Result<()> {
		let path = &self.path;
		with_helper("set_times", path, |conn| {
			write_u8(&mut conn.stdin, OP_SET_TIMES).map_err(|e| e.to_string())?;
			write_u64(&mut conn.stdin, self.handle_id).map_err(|e| e.to_string())?;
			write_file_time(&mut conn.stdin, accessed).map_err(|e| e.to_string())?;
			write_file_time(&mut conn.stdin, modified).map_err(|e| e.to_string())?;
			conn.stdin.flush().map_err(|e| e.to_string())?;
			conn.read_status("set_times", path)
		})
	}

	pub fn sync(&self, data_only: bool) -> io::Result<()> {
		let path = &self.path;
		with_helper("sync", path, |conn| {
			write_u8(&mut conn.stdin, OP_SYNC).map_err(|e| e.to_string())?;
			write_u64(&mut conn.stdin, self.handle_id).map_err(|e| e.to_string())?;
			write_u8(&mut conn.stdin, u8::from(data_only)).map_err(|e| e.to_string())?;
			conn.stdin.flush().map_err(|e| e.to_string())?;
			conn.read_status("sync", path)
		})
	}

	pub fn file_id(&self) -> io::Result<FileId> {
		self
			.metadata()?
			.file_id()
			.ok_or_else(|| io::Error::from(io::ErrorKind::Unsupported))
	}

	pub fn is_locked(&self) -> io::Result<bool> {
		let path = &self.path;
		with_helper("is_locked", path, |conn| {
			write_u8(&mut conn.stdin, OP_IS_LOCKED).map_err(|e| e.to_string())?;
			write_u64(&mut conn.stdin, self.handle_id).map_err(|e| e.to_string())?;
			conn.stdin.flush().map_err(|e| e.to_string())?;
			match conn.read_status("is_locked", path)? {
				Ok(()) => Ok(Ok(read_u8(&mut conn.stdout).map_err(|e| e.to_string())? != 0)),
				Err(err) => Ok(Err(err)),
			}
		})
	}

	pub fn fstat_fs(&self) -> io::Result<StatFs> {
		let path = &self.path;
		with_helper("statfs", path, |conn| {
			write_u8(&mut conn.stdin, OP_FSTAT_FS).map_err(|e| e.to_string())?;
			write_u64(&mut conn.stdin, self.handle_id).map_err(|e| e.to_string())?;
			conn.stdin.flush().map_err(|e| e.to_string())?;
			match conn.read_status("statfs", path)? {
				Ok(()) => Ok(Ok(read_stat_fs(&mut conn.stdout).map_err(|e| e.to_string())?)),
				Err(err) => Ok(Err(err)),
			}
		})
	}

	fn send_close(handle_id: u64, path: &Path) -> io::Result<()> {
		with_helper("close", path, |conn| {
			write_u8(&mut conn.stdin, OP_CLOSE).map_err(|e| e.to_string())?;
			write_u64(&mut conn.stdin, handle_id).map_err(|e| e.to_string())?;
			conn.stdin.flush().map_err(|e| e.to_string())?;
			conn.read_status("close", path)
		})
	}

	pub fn close(mut self) -> io::Result<()> {
		let id = std::mem::replace(&mut self.handle_id, 0);
		if id == 0 {
			return Ok(());
		}
		Self::send_close(id, &self.path)
	}
}

impl Drop for HelperFile {
	fn drop(&mut self) {
		let id = std::mem::replace(&mut self.handle_id, 0);
		if id != 0 {
			let _ = Self::send_close(id, &self.path);
		}
	}
}

pub fn read_all(path: &Path) -> io::Result<Vec<u8>> {
	if in_helper_process() {
		return fs::read(path);
	}
	with_helper("read", path, |conn| {
		write_u8(&mut conn.stdin, OP_READ_ALL).map_err(|e| e.to_string())?;
		write_path(&mut conn.stdin, path).map_err(|e| e.to_string())?;
		conn.stdin.flush().map_err(|e| e.to_string())?;
		match conn.read_status("read", path)? {
			Ok(()) => Ok(Ok(read_bytes(&mut conn.stdout).map_err(|e| e.to_string())?)),
			Err(err) => Ok(Err(err)),
		}
	})
}

pub fn write_all(path: &Path, contents: &[u8]) -> io::Result<()> {
	if in_helper_process() {
		return fs::write(path, contents);
	}
	with_helper("write", path, |conn| {
		write_u8(&mut conn.stdin, OP_WRITE_ALL).map_err(|e| e.to_string())?;
		write_path(&mut conn.stdin, path).map_err(|e| e.to_string())?;
		write_bytes(&mut conn.stdin, contents).map_err(|e| e.to_string())?;
		conn.stdin.flush().map_err(|e| e.to_string())?;
		conn.read_status("write", path)
	})
}

pub fn copy_file(from: &Path, to: &Path) -> io::Result<u64> {
	if in_helper_process() {
		return fs::copy(from, to);
	}
	with_helper("copy", from, |conn| {
		write_u8(&mut conn.stdin, OP_COPY).map_err(|e| e.to_string())?;
		write_path(&mut conn.stdin, from).map_err(|e| e.to_string())?;
		write_path(&mut conn.stdin, to).map_err(|e| e.to_string())?;
		conn.stdin.flush().map_err(|e| e.to_string())?;
		match conn.read_status("copy", from)? {
			Ok(()) => Ok(Ok(read_u64(&mut conn.stdout).map_err(|e| e.to_string())?)),
			Err(err) => Ok(Err(err)),
		}
	})
}
