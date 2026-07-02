-- kitsune-notifications: settings persistence + debug log passthrough.
-- All notification repositioning is done frontend-side (see frontend/index.tsx).

local logger = require("logger")
local millennium = require("millennium")
local json = require("json")

local POSITION_TOP_RIGHT = 1

local SETTINGS_DEFAULTS = {
    enabled = true,
    position = POSITION_TOP_RIGHT,
    effect = "slide",
    slideDirection = "auto",
    marginTopPx = 16,
    marginRightPx = 16,
    marginBottomPx = 16,
    marginLeftPx = 16,
    debugMode = false,
    overlayEnabled = false,
    overlayPosition = POSITION_TOP_RIGHT,
    overlayEffect = "slide",
    overlaySlideDirection = "auto",
    overlayMarginTopPx = 16,
    overlayMarginRightPx = 16,
    overlayMarginBottomPx = 16,
    overlayMarginLeftPx = 16,
    customSoundsEnabled = false,
    soundFileMessage = "",
    soundFileGeneral = "",
    soundFileAchievement = "",
    soundFileFriendOnline = "",
    soundFileFriendInGame = "",
    soundFileScreenshot = "",
    overlaySoundFileMessage = "",
    overlaySoundFileGeneral = "",
    overlaySoundFileAchievement = "",
    overlaySoundFileFriendOnline = "",
    overlaySoundFileFriendInGame = "",
    overlaySoundFileScreenshot = "",
    soundVolumeMessage = 100,
    soundVolumeGeneral = 100,
    soundVolumeAchievement = 100,
    soundVolumeFriendOnline = 100,
    soundVolumeFriendInGame = 100,
    soundVolumeScreenshot = 100,
    overlaySoundVolumeMessage = 100,
    overlaySoundVolumeGeneral = 100,
    overlaySoundVolumeAchievement = 100,
    overlaySoundVolumeFriendOnline = 100,
    overlaySoundVolumeFriendInGame = 100,
    overlaySoundVolumeScreenshot = 100,
}

-- Formats the Chromium/CEF Web Audio decoder accepts.
local SOUND_EXTS = { "mp3", "wav", "ogg", "m4a", "flac", "opus" }

local B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local b64dec_map

local function b64_decode(data)
    if not b64dec_map then
        b64dec_map = {}
        for i = 1, #B64 do b64dec_map[B64:byte(i)] = i - 1 end
    end
    local out, acc, nbits = {}, 0, 0
    for i = 1, #data do
        local v = b64dec_map[data:byte(i)]
        if v then
            acc = acc * 64 + v
            nbits = nbits + 6
            if nbits >= 8 then
                nbits = nbits - 8
                out[#out + 1] = string.char(math.floor(acc / 2 ^ nbits) % 256)
            end
        end
    end
    return table.concat(out)
end

local function b64_encode(data)
    local out, n, i = {}, #data, 1
    while i <= n do
        local b1 = data:byte(i)
        local b2 = data:byte(i + 1)
        local b3 = data:byte(i + 2)
        local c1 = math.floor(b1 / 4)
        local c2 = (b1 % 4) * 16 + (b2 and math.floor(b2 / 16) or 0)
        local c3 = b2 and ((b2 % 16) * 4 + (b3 and math.floor(b3 / 64) or 0)) or 64
        local c4 = b3 and (b3 % 64) or 64
        out[#out + 1] = B64:sub(c1 + 1, c1 + 1) .. B64:sub(c2 + 1, c2 + 1)
            .. (c3 == 64 and "=" or B64:sub(c3 + 1, c3 + 1))
            .. (c4 == 64 and "=" or B64:sub(c4 + 1, c4 + 1))
        i = i + 3
    end
    return table.concat(out)
end

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

-- FFI CreateDirectoryA so we can make the sounds folder without flashing a console.
local ok_ffi, ffi = pcall(require, "ffi")
if ok_ffi then
    pcall(function() ffi.cdef [[ int CreateDirectoryA(const char* path, void* sa); ]] end)
end

local function sounds_dir()
    return plugin_dir() .. "/sounds"
end

local function ensure_sounds_dir()
    if ok_ffi then pcall(function() ffi.C.CreateDirectoryA(sounds_dir(), nil) end) end
end

local function is_valid_ext(ext)
    for _, e in ipairs(SOUND_EXTS) do if e == ext then return true end end
    return false
end

local function sound_path(category, ext)
    return sounds_dir() .. "/" .. category .. "." .. ext
end

local function remove_category_files(category)
    for _, e in ipairs(SOUND_EXTS) do os.remove(sound_path(category, e)) end
end

-- Writes a base64-decoded audio file into sounds/<category>.<ext>, replacing any prior one.
function SaveSound(payload)
    local ok, p = pcall(json.decode, payload)
    if not ok or type(p) ~= "table" or not p.category or not p.ext or not p.data then
        return json.encode({ success = false, error = "invalid payload" })
    end
    if not is_valid_ext(p.ext) then
        return json.encode({ success = false, error = "unsupported format" })
    end
    ensure_sounds_dir()
    remove_category_files(p.category)
    local bytes = b64_decode(p.data)
    local f, err = io.open(sound_path(p.category, p.ext), "wb")
    if not f then return json.encode({ success = false, error = tostring(err) }) end
    f:write(bytes)
    f:close()
    return json.encode({ success = true, file = p.category .. "." .. p.ext })
end

-- Copies a sound from a source path (picked via native dialog) into sounds/<category>.<ext>.
function ImportSound(payload)
    local ok, p = pcall(json.decode, payload)
    if not ok or type(p) ~= "table" or not p.category or not p.path then
        return json.encode({ success = false, error = "invalid payload" })
    end
    local ext = p.path:lower():match("%.([a-z0-9]+)$")
    if not ext or not is_valid_ext(ext) then
        return json.encode({ success = false, error = "unsupported format" })
    end
    local src = io.open(p.path, "rb")
    if not src then return json.encode({ success = false, error = "cannot open file" }) end
    local bytes = src:read("*a")
    src:close()
    ensure_sounds_dir()
    remove_category_files(p.category)
    local out, err = io.open(sound_path(p.category, ext), "wb")
    if not out then return json.encode({ success = false, error = tostring(err) }) end
    out:write(bytes)
    out:close()
    return json.encode({ success = true, file = p.category .. "." .. ext, ext = ext, data = b64_encode(bytes) })
end

-- Returns the stored sound for a category as base64, or found=false.
function LoadSound(payload)
    local ok, p = pcall(json.decode, payload)
    if not ok or type(p) ~= "table" or not p.category then
        return json.encode({ found = false })
    end
    for _, e in ipairs(SOUND_EXTS) do
        local f = io.open(sound_path(p.category, e), "rb")
        if f then
            local bytes = f:read("*a")
            f:close()
            return json.encode({ found = true, ext = e, data = b64_encode(bytes) })
        end
    end
    return json.encode({ found = false })
end

function ClearSound(payload)
    local ok, p = pcall(json.decode, payload)
    if ok and type(p) == "table" and p.category then remove_category_files(p.category) end
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
