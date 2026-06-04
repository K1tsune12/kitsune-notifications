-- kitsune-notifications: reposition Steam notification toast windows.
-- Steam puts toasts at bottom-right; CSS/JS inside the toast can't move it
-- (CEF blocks window.moveTo on these). This plugin walks top-level windows
-- and SetWindowPos's the ones identified as Steam notification toasts.
--
-- Architecture lessons from kitsune-mica:
--   - DO NOT use FFI callbacks (EnumWindows + ffi.cast crashes the Millennium
--     Lua VM at offset 0x789EF reading NULL+0x91 — see kitsune-mica v1.0.2 notes)
--   - Walk windows with GetTopWindow + GetWindow(GW_HWNDNEXT) instead.
--   - All FFI ptr-sized typedefs need uintptr_t/intptr_t, NOT `unsigned long`.

local logger = require("logger")
local millennium = require("millennium")
local json = require("json")
local ffi = require("ffi")

ffi.cdef[[
typedef int BOOL;
typedef unsigned long DWORD;
typedef long LONG;
typedef unsigned long ULONG;
typedef void* HANDLE;
typedef void* HWND;
typedef wchar_t WCHAR;
typedef uintptr_t ULONG_PTR;
typedef intptr_t LONG_PTR;
typedef unsigned int UINT;
typedef int INT;
typedef uintptr_t SIZE_T;
typedef char CHAR;
typedef CHAR *LPSTR;
typedef WCHAR *LPWSTR;

// Window enumeration / inspection
HWND GetTopWindow(HWND hWndParent);
HWND GetWindow(HWND hWnd, UINT uCmd);
BOOL IsWindow(HWND hWnd);
BOOL IsWindowVisible(HWND hWnd);
DWORD GetWindowThreadProcessId(HWND hWnd, DWORD* lpdwProcessId);
int GetClassNameW(HWND hWnd, LPWSTR lpClassName, int nMaxCount);
int GetWindowTextW(HWND hWnd, LPWSTR lpString, int nMaxCount);
int GetWindowTextLengthW(HWND hWnd);

// Positioning
BOOL SetWindowPos(HWND hWnd, HWND hWndInsertAfter, int X, int Y, int cx, int cy, UINT uFlags);
BOOL GetWindowRect(HWND hWnd, void* lpRect);

// Monitor info for screen dimensions
HWND MonitorFromWindow(HWND hwnd, DWORD dwFlags);
BOOL GetMonitorInfoW(HWND hMonitor, void* lpmi);

// Process enumeration (to identify steam.exe windows)
HANDLE CreateToolhelp32Snapshot(DWORD dwFlags, DWORD th32ProcessID);
BOOL Process32FirstW(HANDLE hSnapshot, void* lppe);
BOOL Process32NextW(HANDLE hSnapshot, void* lppe);
BOOL CloseHandle(HANDLE hObject);

// Wall-clock milliseconds since system boot. Lua's os.clock() returns CPU time,
// which barely moves while the plugin is idle — throttles based on it never
// expire after the first burst of activity.
DWORD GetTickCount(void);

// Returns this process's PID. The plugin runs inside steamwebhelper.exe, which
// is the same process that owns Steam's notification toast popups. Using this
// instead of CreateToolhelp32Snapshot + Process32 iteration cuts the per-call
// FFI cost dramatically (one syscall vs hundreds), pushing back the threshold
// at which Millennium's Lua VM trips its known bug at offset 0x789EF.
DWORD GetCurrentProcessId(void);

int WideCharToMultiByte(UINT CodePage, DWORD dwFlags, const WCHAR *lpWideCharStr, int cchWideChar, char *lpMultiByteStr, int cbMultiByte, const char *lpDefaultChar, int *lpUsedDefaultChar);

typedef struct {
    LONG left;
    LONG top;
    LONG right;
    LONG bottom;
} RECT;

typedef struct {
    DWORD cbSize;
    RECT rcMonitor;
    RECT rcWork;
    DWORD dwFlags;
} MONITORINFO;

typedef struct {
    DWORD dwSize;
    DWORD cntUsage;
    DWORD th32ProcessID;
    ULONG_PTR th32DefaultHeapID;
    DWORD th32ModuleID;
    DWORD cntThreads;
    DWORD th32ParentProcessID;
    LONG pcPriClassBase;
    DWORD dwFlags;
    WCHAR szExeFile[260];
} PROCESSENTRY32W;
]]

local C = ffi.C
local user32 = ffi.load("user32")

-- Constants
local GW_HWNDNEXT = 2
local SWP_NOSIZE = 0x0001
local SWP_NOZORDER = 0x0004
local SWP_NOACTIVATE = 0x0010
local SWP_FLAGS = bit.bor(SWP_NOSIZE, SWP_NOZORDER, SWP_NOACTIVATE)
local MONITOR_DEFAULTTONEAREST = 2
local TH32CS_SNAPPROCESS = 0x00000002
local CP_UTF8 = 65001

-- Position constants exposed to JS
local POSITION_BOTTOM_RIGHT = 0
local POSITION_TOP_RIGHT = 1
local POSITION_TOP_LEFT = 2
local POSITION_BOTTOM_LEFT = 3

-- Throttle: dedupe accidental rapid calls. Was 3000ms when the JS hook fired on
-- EVERY window.open (hundreds at startup). Now the JS only fires for windows whose
-- target name starts with "notificationtoasts_" — at most a few per minute — so a
-- short throttle is safe and necessary: Steam animates the toast back to the
-- bottom-right over ~1-2s, so we need to fire several follow-up moves to win.
local function tick_ms() return tonumber(C.GetTickCount()) end

local OUR_PID = tonumber(C.GetCurrentProcessId())

local last_move_time = 0
local MOVE_THROTTLE_MS = 200
local MAX_WINDOW_ITER = 10000
local MARGIN = 16

-- Cache of active toast windows. Key: hwnd-as-number, value: {hwnd, w, h, work}.
local active_toasts = {}
local last_full_walk_time = -1000000
local FULL_WALK_THROTTLE_MS = 1000

-- Cache of steamwebhelper.exe PIDs. Steam runs 1 main + several CEF subprocesses
-- and toast windows may be owned by any of them. find_pids_by_name() is
-- expensive (Toolhelp32 + per-process wstr conversion ~ 300-500 FFI calls), so
-- we cache and refresh at most every PID_CACHE_TTL_MS.
local cached_webhelper_pids = nil
local cached_webhelper_pids_at = -1000000
local PID_CACHE_TTL_MS = 60000  -- 1 minute

-- Reused FFI buffers to keep per-walk cdata allocations minimal. Repeated
-- ffi.new under high call frequency is suspected to contribute to the Lua VM
-- crash at offset 0x789EF (NULL+0x91). Single shared instances live for the
-- module's lifetime.
local pid_buf = ffi.new("DWORD[1]")
local rect_buf = ffi.new("RECT")
local wclass_buf = ffi.new("WCHAR[256]")
local wtitle_buf = ffi.new("WCHAR[256]")
local utf8_buf = ffi.new("char[1024]")

-- Convert wchar buffer to Lua string using the shared 1KB utf8_buf.
local function wstr_to_string(wbuf)
    local res = C.WideCharToMultiByte(CP_UTF8, 0, wbuf, -1, utf8_buf, 1024, nil, nil)
    if res == 0 then return "" end
    return ffi.string(utf8_buf)
end

-- Find PIDs of processes matching exe name (case-insensitive)
local function find_pids_by_name(exe_name)
    local pids = {}
    local snap = C.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snap == ffi.cast("HANDLE", -1) then return pids end
    local ok = pcall(function()
        local entry = ffi.new("PROCESSENTRY32W")
        entry.dwSize = ffi.sizeof(entry)
        local r = C.Process32FirstW(snap, entry)
        while r ~= 0 do
            local name = wstr_to_string(entry.szExeFile)
            if name:lower() == exe_name:lower() then
                table.insert(pids, tonumber(entry.th32ProcessID))
            end
            r = C.Process32NextW(snap, entry)
        end
    end)
    C.CloseHandle(snap)
    return pids
end

-- Get/refresh cached steamwebhelper.exe PIDs.
local function get_webhelper_pids()
    local now = tonumber(C.GetTickCount())
    if cached_webhelper_pids and (now - cached_webhelper_pids_at) < PID_CACHE_TTL_MS then
        return cached_webhelper_pids
    end
    local t = {}
    for _, pid in ipairs(find_pids_by_name("steamwebhelper.exe")) do t[pid] = true end
    cached_webhelper_pids = t
    cached_webhelper_pids_at = now
    return t
end

-- Read size into rect_buf. Returns w,h or nil if it fails.
local function get_size(hwnd)
    if user32.GetWindowRect(hwnd, rect_buf) == 0 then return nil end
    return rect_buf.right - rect_buf.left, rect_buf.bottom - rect_buf.top
end

-- Full inspect using shared buffers. Returns class, title, w, h.
local function inspect_window(hwnd)
    if hwnd == nil or user32.IsWindow(hwnd) == 0 then return nil end
    local clen = user32.GetClassNameW(hwnd, wclass_buf, 256)
    local class_name = clen > 0 and wstr_to_string(wclass_buf) or ""

    if user32.GetWindowRect(hwnd, rect_buf) == 0 then return nil end

    local title = ""
    local title_len = user32.GetWindowTextLengthW(hwnd)
    if title_len > 0 and title_len < 255 then
        user32.GetWindowTextW(hwnd, wtitle_buf, 256)
        title = wstr_to_string(wtitle_buf)
    end

    return {
        class_name = class_name,
        title = title,
        x = rect_buf.left,
        y = rect_buf.top,
        w = rect_buf.right - rect_buf.left,
        h = rect_buf.bottom - rect_buf.top,
        visible = user32.IsWindowVisible(hwnd) ~= 0,
    }
end

-- DEBUG: matches anything; the real heuristic comes after we see what the toast looks like.
-- For now: match windows with class containing "chrome" OR title containing "notification"
-- OR size ~425x105 (allowing tolerance for DPI scaling 100-200%).
local function is_notification_toast(hwnd, info)
    if not info then return false end
    -- Bail on huge windows (main steam window etc.)
    if info.w <= 0 or info.h <= 0 then return false end
    if info.w > 900 or info.h > 350 then return false end

    local cl = info.class_name:lower()
    local tl = info.title:lower()

    if tl:find("notification") then return true end
    -- Toast canonical size 425x105 (and DPI-scaled variants up to ~2x)
    if info.w >= 280 and info.w <= 900 and info.h >= 60 and info.h <= 250 then
        if cl:find("chrome") then return true end
    end

    return false
end

-- Work area (excluding taskbar) of monitor containing the given window
local function get_work_area_for_window(hwnd)
    local hmonitor = user32.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
    if hmonitor == nil then return nil end
    local mi = ffi.new("MONITORINFO")
    mi.cbSize = ffi.sizeof(mi)
    if user32.GetMonitorInfoW(hmonitor, mi) == 0 then return nil end
    return {
        left = mi.rcWork.left,
        top = mi.rcWork.top,
        right = mi.rcWork.right,
        bottom = mi.rcWork.bottom,
    }
end

local function compute_target_xy(position, work, w, h, margin)
    margin = margin or MARGIN
    if position == POSITION_TOP_RIGHT then
        return work.right - w - margin, work.top + margin
    elseif position == POSITION_TOP_LEFT then
        return work.left + margin, work.top + margin
    elseif position == POSITION_BOTTOM_LEFT then
        return work.left + margin, work.bottom - h - margin
    else  -- bottom-right
        return work.right - w - margin, work.bottom - h - margin
    end
end

-- Cheap move of a cached toast: 2-3 FFI calls (IsWindow + maybe GetMonitor + SetWindowPos).
local function move_cached_toast(t, position, margin)
    if user32.IsWindow(t.hwnd) == 0 then return false end
    if not t.work then
        t.work = get_work_area_for_window(t.hwnd)
        if not t.work then return true end
    end
    local x, y = compute_target_xy(position, t.work, t.w, t.h, margin)
    user32.SetWindowPos(t.hwnd, nil, x, y, 0, 0, SWP_FLAGS)
    return true
end

-- Z-order walk to discover toast windows. Populates active_toasts.
-- Two-stage filter to minimize FFI work:
--   Stage 1 (cheap): GetWindowRect for size — skip if not toast-shaped.
--   Stage 2 (cheap): GetWindowThreadProcessId — skip if not a steamwebhelper PID.
--   Stage 3 (expensive): full inspect_window + is_notification_toast.
-- On a typical desktop, stage 1 rejects ~98% of candidates with 1 FFI call each.
local function discover_toasts()
    local new_keys = {}
    local webhelper_pids = get_webhelper_pids()
    local hwnd = user32.GetTopWindow(nil)
    local visited = 0

    while hwnd ~= nil and visited < MAX_WINDOW_ITER do
        visited = visited + 1

        -- Stage 1: size pre-filter (1 FFI). Toasts are ~283x70 after DPI scaling
        -- or ~425x105 logical; allow a generous range and reject the rest fast.
        local w, h = get_size(hwnd)
        if w and h and w >= 200 and w <= 900 and h >= 50 and h <= 250 then
            -- Stage 2: PID check (1 FFI).
            C.GetWindowThreadProcessId(hwnd, pid_buf)
            local pid = tonumber(pid_buf[0]) or 0
            if webhelper_pids[pid] then
                -- Stage 3: full inspect + heuristic match.
                local ok_info, info = pcall(inspect_window, hwnd)
                if ok_info and info and is_notification_toast(hwnd, info) then
                    local key = tonumber(ffi.cast("uintptr_t", hwnd))
                    if key and not active_toasts[key] then
                        active_toasts[key] = { hwnd = hwnd, w = info.w, h = info.h, work = nil }
                        new_keys[#new_keys + 1] = key
                    end
                end
            end
        end

        hwnd = user32.GetWindow(hwnd, GW_HWNDNEXT)
    end

    if visited >= MAX_WINDOW_ITER then
        logger:error(string.format("[kitsune-notif] hit MAX_WINDOW_ITER (%d)", MAX_WINDOW_ITER))
    end
    return new_keys
end

-- Common move impl. discover=true runs a heavy Z-order walk to find new toasts;
-- false just moves cached HWNDs (cheap). Two separate exported callables avoid
-- any boolean-serialization issues across the Millennium IPC boundary (v10's
-- bool flag was reaching Lua as falsy — kept the slow path from ever running).
local function move_impl(args, discover)
    local position = POSITION_TOP_RIGHT
    local margin = MARGIN
    -- Millennium IPC mangles multi-key object args (a `{position, margin}` JS
    -- object reaches Lua with the wrong values), so we pass a JSON string instead.
    -- Also accept a single number for back-compat with the old single-arg style.
    if type(args) == "string" then
        local ok, parsed = pcall(json.decode, args)
        if ok and type(parsed) == "table" then
            if parsed.position ~= nil then position = tonumber(parsed.position) or POSITION_TOP_RIGHT end
            if parsed.margin ~= nil then margin = tonumber(parsed.margin) or MARGIN end
        end
    elseif type(args) == "table" then
        if args.position ~= nil then position = tonumber(args.position) or POSITION_TOP_RIGHT end
        if args.margin ~= nil then margin = tonumber(args.margin) or MARGIN end
    elseif type(args) == "number" then
        position = args
    end

    local now = tick_ms()
    if (now - last_move_time) < MOVE_THROTTLE_MS and not discover then return false end
    last_move_time = now

    -- Fast path: move cached toasts.
    local moved = 0
    local stale = {}
    for key, t in pairs(active_toasts) do
        local ok, still_valid = pcall(move_cached_toast, t, position, margin)
        if not ok or not still_valid then
            stale[#stale + 1] = key
        else
            moved = moved + 1
        end
    end
    for _, key in ipairs(stale) do active_toasts[key] = nil end

    -- Slow path: explicit discover request, throttled as safety net against spam.
    if discover then
        local since_walk = now - last_full_walk_time
        if since_walk >= FULL_WALK_THROTTLE_MS then
            last_full_walk_time = now
            local new_keys = discover_toasts()
            for _, key in ipairs(new_keys) do
                local t = active_toasts[key]
                if t then
                    local ok, still_valid = pcall(move_cached_toast, t, position, margin)
                    if ok and still_valid then moved = moved + 1
                    else active_toasts[key] = nil end
                end
            end
        end
    end

    if moved > 0 then
        logger:info(string.format("[kitsune-notif] moved %d toast(s) pos=%d margin=%d", moved, position, margin))
    end
    return moved > 0
end

-- Two public callables: one for the heavy-walk path (when a new toast appears),
-- one for cheap follow-up moves. Avoids passing a bool flag across IPC.
function DiscoverAndMoveToasts(args)
    return move_impl(args, true)
end

function MoveCachedToasts(args)
    return move_impl(args, false)
end

-- Back-compat alias (theme JS in old toasts may still try to call this).
function MoveNotificationsToCorner(args)
    return move_impl(args, false)
end

-- Settings persistence. The Millennium pluginConfig API (in @steambrew/client) is
-- a no-op stub in this SDK version, so we manage our own JSON file next to
-- plugin.json (same pattern hltb-for-millennium uses).
local SETTINGS_DEFAULTS = {
    enabled = true,
    position = POSITION_TOP_RIGHT,
    delayMs = 1000,
    marginPx = 16,
}

local function settings_path()
    return millennium.get_install_path() .. "/settings.json"
end

local function read_settings_file()
    local path = settings_path()
    local file = io.open(path, "r")
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

function LoadSettings()
    local merged = merge_with_defaults(read_settings_file())
    return json.encode(merged)
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
    -- No initial sweep: there are no toasts on screen at plugin load, so a
    -- discover walk here would be wasted FFI volume against Millennium's
    -- VM crash threshold. The window.open hook handles toasts as they appear.
end

return {
    on_load = on_load,
    on_unload = on_unload,
    on_frontend_loaded = on_frontend_loaded,
}
