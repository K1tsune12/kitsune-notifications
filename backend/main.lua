-- kitsune-notifications: settings persistence + debug log passthrough.
-- All notification repositioning is done frontend-side (see frontend/index.tsx).

local logger = require("logger")
local millennium = require("millennium")
local json = require("json")

local POSITION_TOP_RIGHT = 1

local SETTINGS_DEFAULTS = {
    enabled = true,
    position = POSITION_TOP_RIGHT,
    marginTopPx = 16,
    marginRightPx = 16,
    marginBottomPx = 16,
    marginLeftPx = 16,
    debugMode = false,
    overlayEnabled = false,
    overlayPosition = POSITION_TOP_RIGHT,
    overlayMarginTopPx = 16,
    overlayMarginRightPx = 16,
    overlayMarginBottomPx = 16,
    overlayMarginLeftPx = 16,
}

-- millennium.get_install_path() returns the millennium folder, not the plugin's
-- own folder, so we append the plugin subpath explicitly.
local function plugin_dir()
    return millennium.get_install_path() .. "/plugins/kitsune-notifications"
end

local function settings_path()
    return plugin_dir() .. "/settings.json"
end

-- One-time move from <steam>/millennium/settings.json (shared, v0.3.0 bug) into
-- our plugin folder.
local function migrate_legacy_settings_path()
    local legacy = millennium.get_install_path() .. "/settings.json"
    local target = settings_path()
    if legacy == target then return end
    local lf = io.open(legacy, "r")
    if not lf then return end
    local content = lf:read("*a")
    lf:close()
    local tf = io.open(target, "r")
    if tf then tf:close(); return end
    local out = io.open(target, "w")
    if not out then return end
    out:write(content)
    out:close()
    os.remove(legacy)
    logger:info("[settings] migrated " .. legacy .. " -> " .. target)
end

local function read_settings_file()
    local file = io.open(settings_path(), "r")
    if not file then return {} end
    local content = file:read("*a")
    file:close()
    local ok, parsed = pcall(json.decode, content)
    if not ok or type(parsed) ~= "table" then return {} end
    return parsed
end

-- Filters legacy/unknown keys (only defaults are emitted) so upgrades self-clean.
local function merge_with_defaults(t)
    local out = {}
    for k, v in pairs(SETTINGS_DEFAULTS) do
        if t[k] ~= nil then out[k] = t[k] else out[k] = v end
    end
    return out
end

-- Frontend has no file-log access; this is its passthrough into the plugin log.
function DebugLog(payload)
    if type(payload) == "string" then
        logger:info("[js] " .. payload)
    else
        logger:info("[js] " .. tostring(payload))
    end
    return ""
end

function LoadSettings()
    return json.encode(merge_with_defaults(read_settings_file()))
end

function SaveSettings(payload)
    local ok_decode, parsed = pcall(json.decode, payload)
    if not ok_decode or type(parsed) ~= "table" then
        return json.encode({ success = false, error = "invalid payload" })
    end
    local merged = merge_with_defaults(parsed)
    local file, err = io.open(settings_path(), "w")
    if not file then
        return json.encode({ success = false, error = tostring(err) })
    end
    file:write(json.encode(merged))
    file:close()
    return json.encode({ success = true })
end

local function on_load()
    logger:info("kitsune-notifications loaded with Millennium " .. millennium.version())
    migrate_legacy_settings_path()
    millennium.ready()
end

local function on_unload()
    logger:info("kitsune-notifications unloaded")
end

local function on_frontend_loaded()
    logger:info("kitsune-notifications frontend loaded")
end

return {
    on_load = on_load,
    on_unload = on_unload,
    on_frontend_loaded = on_frontend_loaded,
}
