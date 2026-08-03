function PLUGIN:BackendListVersions(ctx)
    local openpacker = dofile(RUNTIME.pluginDirPath .. "/lib/openpacker.lua")
    local response = openpacker.cli(ctx, {"enumerate", openpacker.purl(ctx), "--target", RUNTIME.osType .. "/" .. RUNTIME.archType})
    local versions = {}
    for _, item in ipairs(response.versions or {}) do table.insert(versions, item.normalizedVersion) end
    if #versions == 0 then error("PREX enumeration returned no eligible versions") end
    return {versions = versions}
end
