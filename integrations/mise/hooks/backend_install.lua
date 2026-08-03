function PLUGIN:BackendInstall(ctx)
    local openpacker = dofile(RUNTIME.pluginDirPath .. "/lib/openpacker.lua")
    local response = openpacker.cli(ctx, {"materialize", openpacker.exact_purl(ctx), "--install-prefix", ctx.install_path})
    if not response.descriptor then error("PREX materialize response did not contain a descriptor") end
    openpacker.record_install(ctx, response)
    return {}
end
