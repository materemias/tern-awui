--!strict
-- tern-awui's part in Tern: parking and unparking panes, which Tern's command line can't do. The
-- server writes a request file named `park-<pane>` or `unpark-<pane>`, holding `<verb> <pane>`, into
-- a `tern-awui-requests` folder and runs `tern open` on it; this route claims that open instead of
-- showing the file. The server then reads `tern ls --json` to see whether the pane moved. A file of
-- that name holding anything else is someone else's: it opens as usual and stays.

tern.route.open(function(req: OpenRequest, cx: WindowCx): RouteDecision?
	if req.origin ~= "cli" then
		return nil
	end
	local verb, id = string.match(req.path, "[/\\]tern%-awui%-requests[/\\](%a+)%-(%d+)$")
	local pane = tonumber(id)
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
