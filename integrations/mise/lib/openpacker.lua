local M = {}

local function shell_quote(value)
    if value:find("%z") then error("OpenPacker option contains NUL") end
    if package.config:sub(1, 1) == "\\" then
        if value:find('[\r\n"]') then error("Unsafe Windows command argument") end
        return '"' .. value .. '"'
    end
    return "'" .. value:gsub("'", "'\\''") .. "'"
end

local function option(ctx, key, environment, fallback)
    local value = ctx.options and ctx.options[key] or nil
    if value == nil and environment ~= nil then value = os.getenv(environment) end
    if value == nil or value == "" then return fallback end
    return value
end

function M.purl(ctx)
    local value = option(ctx, "purl", nil, nil)
    if value == nil and ctx.tool and ctx.tool:sub(1, 4) == "pkg:" then value = ctx.tool end
    if value == nil then
        local key = "OPENPACKER_TOOL_" .. (ctx.tool or ""):upper():gsub("[^A-Z0-9]", "_") .. "_PURL"
        value = os.getenv(key)
    end
    if value == nil or value:sub(1, 4) ~= "pkg:" then error("Set purl in mise options or OPENPACKER_TOOL_<ALIAS>_PURL") end
    return value
end

function M.exact_purl(ctx)
    local purl = M.purl(ctx)
    if purl:match("@[^/?#]+") then error("mise tool PURL must not already contain a version") end
    if not ctx.version or ctx.version == "" or ctx.version:find("[^A-Za-z0-9._+-]") then error("Invalid exact tool version") end
    return purl .. "@" .. ctx.version
end

function M.cli(ctx, arguments)
    local cmd = require("cmd")
    local executable = option(ctx, "opm_bin", "OPENPACKER_BIN", "opm")
    local service = option(ctx, "service_url", "OPENPACKER_URL", "http://127.0.0.1:7337")
    local command = shell_quote(executable)
    for _, argument in ipairs(arguments) do command = command .. " " .. shell_quote(argument) end
    command = command .. " --json --base-url " .. shell_quote(service)
    local token_file = option(ctx, "auth_token_file", "OPENPACKER_AUTH_TOKEN_FILE", nil)
    if token_file ~= nil then command = command .. " --auth-token-file " .. shell_quote(token_file) end
    if option(ctx, "offline", "OPENPACKER_OFFLINE", "true") ~= "false" then command = command .. " --offline" end
    local success, output = pcall(cmd.exec, command)
    if not success then error("OpenPacker command failed: " .. tostring(output)) end
    local decoded = require("json").decode(output)
    if decoded.error then error("OpenPacker error: " .. tostring(decoded.error.message or "unknown")) end
    return decoded
end

local function validate_relative(path)
    if type(path) ~= "string" or path == "" or path:sub(1, 1) == "/" or path:match("^[A-Za-z]:") or path:find("\\") then error("Executable path must be portable and relative") end
    for part in path:gmatch("[^/]+") do if part == "." or part == ".." or part == "" then error("Executable path escapes installation prefix") end end
    return path
end

function M.executables(descriptor)
    local extensions = descriptor.extensions or {}
    local config = extensions["org.openpacker.mise"] or {}
    local executables = config.executables
    if type(executables) ~= "table" or #executables == 0 then error("Artifact descriptor has no declared org.openpacker.mise executables") end
    for index, path in ipairs(executables) do executables[index] = validate_relative(path) end
    return executables
end

function M.record_install(ctx, response)
    local file = require("file")
    local json = require("json")
    local descriptor = response.descriptor
    local installation = response.installation
    if type(descriptor) ~= "table" or type(installation) ~= "table" or installation.lifecycleScriptsExecuted ~= false then error("OpenPacker CLI did not return a safe materialization manifest") end
    local executables = M.executables(descriptor)
    for _, path in ipairs(executables) do if not file.exists(file.join_path(ctx.install_path, path)) then error("Declared executable missing after extraction: " .. path) end end
    local manifest = assert(io.open(file.join_path(ctx.install_path, ".openpacker-mise.json"), "wb"))
    manifest:write(json.encode({descriptorDigest = "sha256:" .. descriptor.digest.value, executables = executables, lifecycleScriptsExecuted = false}))
    manifest:close()
end

return M
