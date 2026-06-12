-- kitsune-notifications: reposition Steam notification toast windows.
--
-- v0.3.0+: pure settings persistence backend. All window repositioning is
-- done frontend-side via g_PopupManager.AddPopupCreatedCallback + popup
-- window.moveTo. No FFI, no Win32, no Lua VM crash exposure.

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
}

local function settings_path()
    return millennium.get_install_path() .. "/settings.json"
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

local function merge_with_defaults(t)
    local out = {}
    for k, v in pairs(SETTINGS_DEFAULTS) do
        if t[k] ~= nil then out[k] = t[k] else out[k] = v end
    end
    return out
end

-- Debug logging from the frontend (frontend has no native log file access).
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
