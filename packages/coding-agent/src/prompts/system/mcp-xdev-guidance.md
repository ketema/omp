## MCP Tool Routes

{{#if tools.length}}
The agent SHALL execute each mounted MCP tool via the native `write` tool by providing the destination path and a JSON-encoded string in `content` matching the tool's schema:
`write(path="xd://<device>", content=JSON_STRING)`

The agent SHALL NOT use `hub.send` or subprocess commands to execute `xd://` virtual devices.
To inspect a device's parameter schema or documentation, the agent SHALL invoke `read(path="xd://<device>")`.
To list all mounted virtual devices, the agent SHALL invoke `read(path="xd://")`.

Mounted routes:
{{#each tools}}
- {{mcpToolName}} → `{{path}}`
{{/each}}
{{/if}}
{{#if hasOmittedTools}}
Additional mounted MCP tool mappings omitted: prompt bounded. Inspect `xd://` for exact current paths.
{{/if}}
