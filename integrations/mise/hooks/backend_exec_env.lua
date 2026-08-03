function PLUGIN:BackendExecEnv(ctx)
    local file = require("file")
    local json = require("json")
    local manifest_path = file.join_path(ctx.install_path, ".openpacker-mise.json")
    if not file.exists(manifest_path) then error("OpenPacker mise installation manifest is missing") end
    local manifest = json.decode(file.read(manifest_path))
    if manifest.lifecycleScriptsExecuted ~= false then error("OpenPacker installation script invariant is missing") end
    local directories = {}
    local seen = {}
    for _, executable in ipairs(manifest.executables or {}) do
        local directory = executable:match("^(.*)/[^/]+$") or "."
        local path = directory == "." and ctx.install_path or file.join_path(ctx.install_path, directory)
        if not seen[path] then table.insert(directories, path); seen[path] = true end
    end
    if #directories == 0 then error("OpenPacker installation declares no executable paths") end
    return {env_vars = {{key = "PATH", value = table.concat(directories, package.config:sub(1, 1) == "\\" and ";" or ":")}}}
end
