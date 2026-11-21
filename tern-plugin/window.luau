--!strict
-- tern-awui's part in Tern: parking and unparking panes, which Tern's command line can't do. The
-- server writes a request file named `park-<pane>` or `unpark-<pane>`, holding `<verb> <pane>`, into
-- a `tern-awui-requests` folder and runs `tern open` on it; this route claims that open instead of
-- showing the file. An unpark may also name a session, `unpark <pane> <session id>`: the pane's new
-- tab opens there instead of in the session it was parked from. The server then reads `tern ls
-- --json` to see whether the pane moved. `decks-0`, holding `decks 0`, asks which panes sit parked
-- in this window's sessions: their ids go one per line into `decks.out` beside it. A pane `tern ls`
-- lists in no tab and that isn't among them (parked in a session since closed) can't come back.
-- A file of that name holding anything else is someone else's: it opens as usual and stays.

tern.route.open(function(req: OpenRequest, cx: WindowCx): RouteDecision?
	if req.origin ~= "cli" then
		return nil
	end
	local verb, id = string.match(req.path, "[/\\]tern%-awui%-requests[/\\](%a+)%-(%d+)$")
	local pane = tonumber(id)
	if verb == "decks" and id == "0" then
		local read, body = pcall(tern.fs.read, req.path, 64)
		if not read or body ~= "decks 0\n" then
			return nil
		end
		pcall(tern.fs.remove, req.path)
		local ids = {}
		for _, p in cx.session:panes() do
			if p.parked then
				table.insert(ids, tostring(p.pane))
			end
		end
		local out = string.gsub(req.path, "decks%-0$", "decks.out")
		local wrote, err = pcall(tern.fs.write, out, table.concat(ids, "\n") .. "\n")
		if not wrote then
			tern.log.warn("tern-awui: decks", err)
		end
		return { handled = true }
	end
	if (verb ~= "park" and verb ~= "unpark") or pane == nil then
		return nil
	end
	local read, body = pcall(tern.fs.read, req.path, 64)
	if not read then
		return nil
	end
	local session: number? = nil
	if body ~= `{verb} {id}\n` then
		local target = verb == "unpark" and string.match(body, `^unpark {id} (%d+)\n$`)
		session = if target then tonumber(target) else nil
		if session == nil then
			return nil
		end
	end
	pcall(tern.fs.remove, req.path)
	local ok: boolean, err: string?
	if verb == "park" then
		ok, err = cx.layout:park(pane)
	else
		-- Into a tab of its own, leaving the desktop on what it shows: the phone opens the pane.
		local tab
		tab, err = cx.layout:move_to_new_tab(pane, session, { focus = false })
		ok = tab ~= nil
	end
	if not ok then
		tern.log.warn("tern-awui:", verb, pane, err)
	end
	return { handled = true }
end)

-- Update check: twice a day at most, the checkout's version (`../package.json`, the installer links
-- this folder from the checkout) is compared with GitHub's latest release. A newer one shows one
-- info toast, once per release across every window (`tern.kv`), and the palette offers "tern-awui:
-- Update", which opens a shell tab in the checkout with the README's update typed for Enter, and
-- "What's new", the release page. A plugin installed as a copy has no checkout beside it and checks
-- nothing.

local RELEASES = "https://api.github.com/repos/materemias/tern-awui/releases/latest"
local CHECK_EVERY_S = 12 * 3600
local RETRY_S = 3600
local UPDATE = "git pull --ff-only && bun install && bun install.ts"

--- The last check: when the next is due (os.time), the latest release then, its page, and the
--- release a toast already announced.
type Known = { due: number, latest: string?, url: string?, announced: string? }

local repo = string.gsub(tern.plugin.dir, "[/\\]tern%-plugin[/\\]?$", "")

--- `x.y.z` as numbers, nil for anything else (a prerelease tag included).
local function semver(v: string?): { number }?
	local a, b, c = string.match(v or "", "^v?(%d+)%.(%d+)%.(%d+)$")
	return if a then { tonumber(a) :: number, tonumber(b) :: number, tonumber(c) :: number } else nil
end

local function newer(latest: string?, current: string?): boolean
	local l, c = semver(latest), semver(current)
	if not l or not c then
		return false
	end
	for i = 1, 3 do
		if l[i] ~= c[i] then
			return l[i] > c[i]
		end
	end
	return false
end

--- The checkout's version, read each time so a `git pull` counts at once; nil without a checkout.
local function installed(): string?
	if repo == tern.plugin.dir then
		return nil
	end
	local ok, text = pcall(tern.fs.read, repo .. "/package.json", 65536)
	if not ok then
		return nil
	end
	local okj, pkg = pcall(tern.json.decode, text)
	return if okj and type(pkg) == "table" and type(pkg.version) == "string" then pkg.version else nil
end

local function known(): Known?
	local ok, k = pcall(tern.kv.get, "update")
	return if ok and type(k) == "table" and type(k.due) == "number" then k :: Known else nil
end

--- The newer release and the checkout's version, when a newer one is known.
local function available(): (Known?, string?)
	local k, version = known(), installed()
	return if k and newer(k.latest, version) then k else nil, version
end

local function announce(cx: WindowCx?)
	local k, version = available()
	if not k or not cx or k.announced == k.latest then
		return
	end
	local seen = table.clone(k)
	seen.announced = k.latest
	tern.kv.set("update", seen)
	cx:toast("info", `tern-awui {k.latest} is out`, `You have {version}. Palette: tern-awui: Update`)
end

local function check(cx: WindowCx?)
	if not installed() then
		return
	end
	local now = os.time()
	local k = known()
	-- Due later, and not so far off that the clock went back.
	if k and now < k.due and k.due - now <= CHECK_EVERY_S then
		announce(cx)
		return
	end
	-- Claimed before asking, so the other windows' ticks wait instead of asking too.
	local claim: Known = if k then table.clone(k) else { due = 0 }
	claim.due = now + RETRY_S
	tern.kv.set("update", claim)
	tern.fetch(RELEASES, {
		headers = { Accept = "application/vnd.github+json", ["User-Agent"] = "tern-awui" },
		timeout_ms = 10000,
	}, function(res: FetchResult, cx: WindowCx?)
		local latest: string?, url: string? = nil, nil
		if res.status == 200 then
			local ok, rel = pcall(tern.json.decode, res.body)
			if ok and type(rel) == "table" and type(rel.tag_name) == "string" then
				latest = string.gsub(rel.tag_name, "^v", "")
				url = if type(rel.html_url) == "string" then rel.html_url else nil
			end
		end
		-- Read again: another window may have announced since the claim.
		local cur = known() or claim
		if latest then
			tern.kv.set("update", { due = now + CHECK_EVERY_S, latest = latest, url = url, announced = cur.announced })
		else
			-- The claim stands: the next try comes in an hour, with the last answer kept.
			tern.log.warn("tern-awui: update check failed", res.error or res.status)
		end
		announce(cx)
	end)
end

-- Ticks hourly; the due time in `tern.kv` keeps GitHub to twice a day. A minute in, out of the way
-- of the window's start.
local function every(cx: WindowCx?)
	tern.timer(RETRY_S * 1000, every)
	local ok, err = pcall(check, cx)
	if not ok then
		tern.log.warn("tern-awui: update check", err)
	end
end

tern.timer(60000, every)

tern.command({
	id = "update",
	title = "tern-awui: Update",
	icon = "download",
	available = function()
		return available() ~= nil
	end,
	run = function(cx: WindowCx)
		if not available() then
			return
		end
		local pane = cx.layout:new_tab({ cwd = repo })
		if not pane then
			cx:toast("error", "tern-awui: couldn't open a tab", `Run {UPDATE} in {repo}`)
			return
		end
		-- Typed, not run: a reinstall without the `--port` or `TERN_AWUI_*` settings of the first
		-- install would reset them, so the user adds them before Enter.
		cx:run(pane, UPDATE)
		cx:toast("info", "Press Enter to update tern-awui", "Add --port or TERN_AWUI_* first if you installed with them")
	end,
})

tern.command({
	id = "release-notes",
	title = "tern-awui: What's new",
	icon = "info",
	available = function()
		local k = available()
		return k ~= nil and k.url ~= nil
	end,
	run = function(cx: WindowCx)
		local k = available()
		if k and k.url then
			cx:open(k.url)
		end
	end,
})
