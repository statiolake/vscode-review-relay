-- require('review_relay'): Review Relay's Neovim frontend.
--
-- The review is the core's (cmd/review-relay in this repository): its server
-- keeps, validates and stores the threads and tells every client of a
-- change (the VS Code extension, agents through the CLI, this). This module
-- shows the review in Neovim and writes what you do back through the same
-- API, over `review-relay attach` (client.lua). Nothing about a review is
-- decided here, and nothing about diffs is known: a diff tool that shows the
-- work tree's files in their own buffers gets threads there for free.
--
-- * A thread belongs to lines of a file of the work tree. The file is the
--   buffer's own (its name, under the review's root), so a thread shows in
--   any window on that buffer — a plain one, or one in diff mode — and a
--   comment goes where the cursor is. A buffer that is not a work-tree file
--   (a scratch buffer of an old revision) takes no comments, and says so.
-- * Threads are anchored with extmarks: they follow your edits, and a moved
--   thread is told to the review (PUT /v1/comments/:id/location), as VS
--   Code does.
-- * In DevHub's GUI (devhub.nvim's gui.inline / gui.view, its public API) a
--   thread is a card under its last line and the panel is drawn; elsewhere
--   the same thread is virt_lines and the panel is its text. Neovim keeps
--   the keys either way.

local Client = require 'review_relay.client'
local cards = require 'review_relay.cards'
local compose = require 'review_relay.compose'

local M = {}

M.config = {
  -- The core's executable; nil: the one build.lua put in this plugin
  -- (bin/<os>-<arch>/review-relay), the same the VS Code extension ships.
  cmd = nil,
  -- Use a review that is already running for the directory (another
  -- editor, `review-relay serve`) when Neovim starts and when the directory
  -- changes, without starting one.
  auto_attach = true,
  -- Your name on what you write; nil: `git config user.name`.
  author = nil,
  -- The panel's width, in columns.
  width = 54,
  -- Keys on a thread's lines in a file buffer (false: none). Elsewhere
  -- they are what they were.
  thread_keys = { reply = 'r', resolve = 's' },
  -- Keys in every file buffer of the review (false: none).
  keys = { next = ']r', prev = '[r' },
  -- A notification when the agent answers.
  notify = true,
  -- Highlight groups (or devhub tones) the review wears.
  colors = {
    agent = 'Function',
    human = 'DiagnosticInfo',
    waiting = 'DiagnosticWarn',
    resolved = 'Comment',
    ok = 'DiagnosticOk',
  },
}

local state = {
  client = nil,
  root = nil,
  comments = {},
  overall = '',
  seen = nil,
  bufs = {}, -- buf -> { anchors = { [thread id] = { mark, line, endLine } }, cards = { [id] = handle } }
}
M._state = state

local ns_anchor = vim.api.nvim_create_namespace 'review_relay_anchor'
local ns_deco = vim.api.nvim_create_namespace 'review_relay'
local group = vim.api.nvim_create_augroup('review_relay', { clear = true })

-- devhub.nvim's GUI, when it is installed and DevHub draws this Neovim.
local function gui()
  local ok, devhub = pcall(require, 'devhub')
  local g = ok and devhub.gui or nil
  if g and g.available() then
    return g
  end
  return nil
end
M._gui = gui

local function notify(message, level)
  local g = gui()
  if g and g.notify then
    g.notify { group = 'review-relay', msg = message, level = level or 'info' }
  else
    vim.notify('review-relay: ' .. message, level == 'warn' and vim.log.levels.WARN or level == 'error' and vim.log.levels.ERROR or vim.log.levels.INFO)
  end
end
M._notify = notify

-- The executable --------------------------------------------------------------

local function plugin_root()
  local here = debug.getinfo(1, 'S').source:sub(2)
  return vim.fn.fnamemodify(here, ':p:h:h:h')
end

--- bin/<os>-<arch>/review-relay of this plugin, the layout build.lua and
--- the VS Code extension's build share.
function M.executable()
  if M.config.cmd then
    return M.config.cmd
  end
  local uname = (vim.uv or vim.loop).os_uname()
  local os_name = ({ Linux = 'linux', Darwin = 'darwin', Windows_NT = 'windows' })[uname.sysname] or uname.sysname:lower()
  local arch = ({ x86_64 = 'amd64', amd64 = 'amd64', arm64 = 'arm64', aarch64 = 'arm64' })[uname.machine] or uname.machine
  local name = os_name == 'windows' and 'review-relay.exe' or 'review-relay'
  return table.concat({ plugin_root(), 'bin', os_name .. '-' .. arch, name }, '/')
end

-- The review, as data -------------------------------------------------------------

--- Threads from the flat comment list: the root, its replies, a status.
function M.threads(comments)
  local by_id, list = {}, {}
  for _, c in ipairs(comments or state.comments) do
    if not c.parentId then
      local t = { id = c.id, root = c, comments = { c }, path = c.path, line = c.line, endLine = c.endLine }
      by_id[c.id] = t
      table.insert(list, t)
    end
  end
  for _, c in ipairs(comments or state.comments) do
    local t = c.parentId and by_id[c.parentId]
    if t then
      table.insert(t.comments, c)
    end
  end
  for _, t in ipairs(list) do
    local last = t.comments[#t.comments]
    t.status = t.root.resolved and 'resolved' or (last.source == 'agent' and 'answered' or 'waiting')
  end
  table.sort(list, function(a, b)
    if a.path ~= b.path then
      return a.path < b.path
    end
    if a.line ~= b.line then
      return a.line < b.line
    end
    return a.root.createdAt < b.root.createdAt
  end)
  return list
end

local function thread_by_id(id)
  for _, t in ipairs(M.threads()) do
    if t.id == id then
      return t
    end
  end
  return nil
end

-- Buffers -------------------------------------------------------------------------

--- The work-tree path (relative to the review's root) of the file buf
--- shows, or nil: a file buffer named under the root.
function M.path_of(buf)
  if not state.root or not vim.api.nvim_buf_is_valid(buf) or vim.bo[buf].buftype ~= '' then
    return nil
  end
  local name = vim.api.nvim_buf_get_name(buf)
  if name == '' or name:match '^%a[%w+.-]*://' then
    return nil
  end
  name = vim.fn.resolve(vim.fn.fnamemodify(name, ':p'))
  if name:sub(1, #state.root + 1) == state.root .. '/' then
    return name:sub(#state.root + 2)
  end
  return nil
end

-- The thread's lines in buf as they are now (0-based), following edits.
local function live(buf, anchor)
  local ok, pos = pcall(vim.api.nvim_buf_get_extmark_by_id, buf, ns_anchor, anchor.mark, { details = true })
  if not ok or not pos[1] then
    return anchor.line, anchor.endLine
  end
  local first = pos[1]
  local last = pos[3] and pos[3].end_row or first
  return first, math.max(first, last)
end

local function place(buf, t)
  local count = vim.api.nvim_buf_line_count(buf)
  local first, last = math.min(t.line, count - 1), math.min(t.endLine, count - 1)
  local mark = vim.api.nvim_buf_set_extmark(buf, ns_anchor, first, 0, {
    end_row = last,
    end_col = 0,
    right_gravity = false,
    end_right_gravity = true,
  })
  return { mark = mark, line = t.line, endLine = t.endLine }
end

local function buf_threads(buf)
  local path = M.path_of(buf)
  local out = {}
  if not path then
    return out, nil
  end
  for _, t in ipairs(M.threads()) do
    if t.path == path then
      table.insert(out, t)
    end
  end
  return out, path
end

--- The threads covering line lnum (1-based) of buf, where they are now.
function M.threads_at(buf, lnum)
  buf = buf == 0 and vim.api.nvim_get_current_buf() or buf
  local b = state.bufs[buf]
  local out = {}
  for _, t in ipairs((buf_threads(buf))) do
    local anchor = b and b.anchors[t.id]
    local first, last = t.line, t.endLine
    if anchor then
      first, last = live(buf, anchor)
    end
    if lnum - 1 >= first and lnum - 1 <= last then
      table.insert(out, t)
    end
  end
  return out
end

local function map_buffer_keys(buf, on)
  local b = state.bufs[buf]
  if not b then
    return
  end
  local wanted = {}
  if on then
    for action, lhs in pairs(M.config.thread_keys or {}) do
      wanted[lhs] = function()
        local here = M.threads_at(buf, vim.api.nvim_win_get_cursor(0)[1])
        if #here == 0 then
          return lhs
        end
        vim.schedule(function()
          M[action]()
        end)
        return ''
      end
    end
  end
  for action, lhs in pairs(M.config.keys or {}) do
    wanted[lhs] = function()
      vim.schedule(function()
        M.jump(action == 'next' and 1 or -1)
      end)
      return ''
    end
  end
  for lhs in pairs(b.keys or {}) do
    if not wanted[lhs] then
      pcall(vim.keymap.del, 'n', lhs, { buffer = buf })
    end
  end
  for lhs, fn in pairs(wanted) do
    vim.keymap.set('n', lhs, fn, { buffer = buf, expr = true, desc = 'review-relay' })
  end
  b.keys = wanted
end

--- Anchors, signs and cards (or virt_lines) for the threads of buf.
function M.decorate(buf)
  if not vim.api.nvim_buf_is_valid(buf) or not vim.api.nvim_buf_is_loaded(buf) then
    return
  end
  local threads, path = buf_threads(buf)
  local b = state.bufs[buf]
  if not path and not b then
    return
  end
  if not b then
    b = { anchors = {}, cards = {}, keys = {} }
    state.bufs[buf] = b
    vim.api.nvim_create_autocmd({ 'TextChanged', 'TextChangedI' }, {
      group = group,
      buffer = buf,
      callback = function()
        M._edited(buf)
      end,
    })
  end
  vim.api.nvim_buf_clear_namespace(buf, ns_deco, 0, -1)
  local g = gui()
  local keep = {}
  for _, t in ipairs(threads) do
    local anchor = b.anchors[t.id]
    -- Placed again when the review moved it (a reply chose a new place),
    -- not when it is where this buffer last said it is.
    if not anchor or anchor.line ~= t.line or anchor.endLine ~= t.endLine then
      if anchor then
        pcall(vim.api.nvim_buf_del_extmark, buf, ns_anchor, anchor.mark)
      end
      anchor = place(buf, t)
      b.anchors[t.id] = anchor
    end
    keep[t.id] = true
    local first, last = live(buf, anchor)
    for l = first, last do
      vim.api.nvim_buf_set_extmark(buf, ns_deco, l, 0, { sign_text = '▎', sign_hl_group = cards.tone(M.config, t.status), priority = 20 })
    end
    local actions = {
      reply = function()
        M.reply(t)
      end,
      resolve = function()
        M.resolve(t)
      end,
    }
    if g then
      b.cards[t.id] = g.inline {
        buf = buf,
        lnum = last + 1,
        id = 'review-relay:' .. t.id,
        range = { first + 1, last + 1 },
        component = cards.card(g.ui, M.config, t, actions),
      }
    else
      vim.api.nvim_buf_set_extmark(buf, ns_deco, last, 0, { virt_lines = cards.virt_lines(M.config, t, 2) })
    end
  end
  for id, anchor in pairs(b.anchors) do
    if not keep[id] then
      pcall(vim.api.nvim_buf_del_extmark, buf, ns_anchor, anchor.mark)
      b.anchors[id] = nil
    end
  end
  for id, handle in pairs(b.cards) do
    if not keep[id] then
      handle:clear()
      b.cards[id] = nil
    end
  end
  map_buffer_keys(buf, #threads > 0)
end

local function decorate_all()
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(buf) and (state.bufs[buf] or M.path_of(buf)) then
      M.decorate(buf)
    end
  end
end

local function undecorate(buf)
  local b = state.bufs[buf]
  if not b then
    return
  end
  for _, handle in pairs(b.cards) do
    handle:clear()
  end
  if vim.api.nvim_buf_is_valid(buf) then
    vim.api.nvim_buf_clear_namespace(buf, ns_deco, 0, -1)
    vim.api.nvim_buf_clear_namespace(buf, ns_anchor, 0, -1)
    for lhs in pairs(b.keys or {}) do
      pcall(vim.keymap.del, 'n', lhs, { buffer = buf })
    end
    pcall(vim.api.nvim_clear_autocmds, { group = group, buffer = buf, event = { 'TextChanged', 'TextChangedI' } })
  end
  state.bufs[buf] = nil
end

-- An edit moved lines: the threads that moved are told to the review, and
-- the cards follow at once.
local sync_timers = {}
function M._edited(buf)
  if sync_timers[buf] then
    sync_timers[buf]:stop()
  end
  sync_timers[buf] = vim.defer_fn(function()
    sync_timers[buf] = nil
    local b = state.bufs[buf]
    local path = M.path_of(buf)
    if not b or not path or not state.client then
      return
    end
    for id, anchor in pairs(b.anchors) do
      local first, last = live(buf, anchor)
      if first ~= anchor.line or last ~= anchor.endLine then
        anchor.line, anchor.endLine = first, last
        state.client:request('PUT', '/v1/comments/' .. id .. '/location', { path = path, line = first, endLine = last }, function(ok, body)
          if not ok and state.client then
            notify(body.error or 'could not move the thread', 'warn')
          end
        end)
      end
    end
    M.decorate(buf)
  end, 250)
end

-- Reading the review ------------------------------------------------------------------

local function call(method, path, body, cb)
  if not state.client then
    notify('no review is open (:ReviewRelay)', 'warn')
    return
  end
  state.client:request(method, path, body, function(ok, data)
    if not ok then
      notify(data.error or ('the review refused ' .. method .. ' ' .. path), 'warn')
    end
    if cb then
      cb(ok, data)
    end
  end)
end
M._call = call

local listeners = {}
--- fn() after every read of the review (the panel draws itself again).
function M.on_change(fn)
  table.insert(listeners, fn)
end

local function changed()
  decorate_all()
  for _, fn in ipairs(listeners) do
    pcall(fn)
  end
end

local function announce_replies(comments)
  local fresh = {}
  for _, c in ipairs(comments) do
    if cards.is_agent(c) and state.seen and not state.seen[c.id] then
      table.insert(fresh, c)
    end
  end
  state.seen = state.seen or {}
  for _, c in ipairs(comments) do
    state.seen[c.id] = true
  end
  if not M.config.notify then
    return
  end
  for _, c in ipairs(fresh) do
    local g = gui()
    local message = ('%s replied on %s:%d'):format(c.author or 'agent', vim.fn.fnamemodify(c.path, ':t'), c.line + 1)
    if g then
      g.notify { group = 'review-relay', key = 'review-relay:' .. c.id, msg = message }
    else
      vim.notify(message, vim.log.levels.INFO, { title = 'review-relay' })
    end
  end
end

--- Read the review again.
function M.refresh(cb)
  if not state.client then
    return
  end
  state.client:request('GET', '/v1/comments', nil, function(ok, data)
    if ok then
      announce_replies(data.comments or {})
      state.comments = data.comments or {}
      state.overall = data.overall or ''
    end
    changed()
    if cb then
      cb()
    end
  end)
end

local refresh_timer
local function refresh_soon()
  if refresh_timer then
    refresh_timer:stop()
  end
  refresh_timer = vim.defer_fn(function()
    refresh_timer = nil
    M.refresh()
  end, 60)
end

--- A window to show a file in: the current one unless it is the panel or
--- a float, else the first ordinary one.
function M.code_window()
  local function usable(win)
    local buf = vim.api.nvim_win_get_buf(win)
    return vim.api.nvim_win_get_config(win).relative == '' and vim.bo[buf].filetype ~= 'review-relay'
  end
  if usable(0) then
    return vim.api.nvim_get_current_win()
  end
  local prev = vim.fn.win_getid(vim.fn.winnr '#')
  if prev ~= 0 and usable(prev) then
    return prev
  end
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if usable(win) then
      return win
    end
  end
  return nil
end

--- Show path (relative to the root) at line (0-based) in a code window.
function M.show(path, line)
  local win = M.code_window()
  if win then
    vim.api.nvim_set_current_win(win)
  else
    vim.cmd 'botright vnew'
  end
  vim.cmd('silent drop ' .. vim.fn.fnameescape(state.root .. '/' .. path))
  if line then
    pcall(vim.api.nvim_win_set_cursor, 0, { line + 1, 0 })
    vim.cmd 'normal! zvzz'
  end
end

-- Attaching ---------------------------------------------------------------------------

local function on_attached(info, first)
  local was = state.root
  state.root = vim.fn.resolve(info.root)
  state.endpoint = info.endpoint
  if was and was ~= state.root then
    for buf in pairs(state.bufs) do
      undecorate(buf)
    end
  end
  if first then
    notify((info.owner and 'started the review of %s' or 'joined the review of %s'):format(vim.fn.fnamemodify(state.root, ':~')))
  end
  M.refresh()
end

--- Attach to the review of the current directory: the one running, or one
--- this Neovim runs unless no_start. cb(ok) once attached or failed.
function M.attach(opts, cb)
  opts = opts or {}
  if state.client and state.client:running() then
    if cb then
      cb(true)
    end
    return
  end
  local cmd = M.executable()
  if not M.config.cmd and vim.fn.executable(cmd) == 0 then
    local message = 'review-relay is not built in this plugin: run :Lazy build vscode-review-relay (needs Go)'
    if not opts.quiet then
      notify(message, 'error')
    end
    if cb then
      cb(false)
    end
    return
  end
  local first = true
  local settled = false
  local client
  client = Client.start {
    cmd = cmd,
    dir = vim.fn.getcwd(),
    no_start = opts.no_start,
    on_attached = function(info)
      on_attached(info, first)
      first = false
      if not settled then
        settled = true
        if cb then
          cb(true)
        end
      end
    end,
    on_event = function(name, data)
      if name == 'state' then
        refresh_soon()
      elseif name == 'navigate' and type(data) == 'table' and data.path then
        M.show(data.path, data.line)
      end
    end,
    on_exit = function(message)
      if state.client == client then
        M.detach()
        if message and not opts.quiet then
          notify(message, 'warn')
        end
      end
      if not settled then
        settled = true
        if cb then
          cb(false)
        end
      end
    end,
  }
  state.client = client
end

--- Leave the review: cards, signs and keys go; a review this Neovim ran
--- stops (its comments are stored).
function M.detach()
  local client = state.client
  state.client = nil
  if client then
    client:stop()
  end
  for buf in pairs(state.bufs) do
    undecorate(buf)
  end
  state.root, state.comments, state.overall, state.seen = nil, {}, '', nil
  for _, fn in ipairs(listeners) do
    pcall(fn)
  end
end

function M.attached()
  return state.client ~= nil and state.root ~= nil
end

-- Actions -------------------------------------------------------------------------------

local function author()
  if M.config.author then
    return M.config.author
  end
  if state.author == nil then
    local name = vim.fn.systemlist({ 'git', '-C', state.root or '.', 'config', 'user.name' })[1]
    state.author = vim.v.shell_error == 0 and name and vim.trim(name) ~= '' and vim.trim(name) or false
  end
  return state.author or nil
end

local function with_review(fn)
  if M.attached() then
    return fn()
  end
  M.attach({}, function(ok)
    if ok then
      fn()
    end
  end)
end

-- Choose one of several (vim.ui.select), or the only one.
local function choose(items, prompt, label, fn)
  if #items == 0 then
    return
  end
  if #items == 1 then
    return fn(items[1])
  end
  vim.ui.select(items, { prompt = prompt, format_item = label }, function(item)
    if item then
      fn(item)
    end
  end)
end

local function thread_here(prompt, fn)
  local buf = vim.api.nvim_get_current_buf()
  local here = M.threads_at(buf, vim.api.nvim_win_get_cursor(0)[1])
  if #here == 0 then
    notify 'no thread on this line'
    return
  end
  choose(here, prompt, function(t)
    return cards.range_label(t) .. '  ' .. cards.first_line(t.root.body)
  end, fn)
end

local function where(t)
  -- In a buffer that shows its file, where it is now; else where the review has it.
  for buf, b in pairs(state.bufs) do
    local anchor = b.anchors[t.id]
    if anchor and M.path_of(buf) == t.path then
      local first, last = live(buf, anchor)
      return buf, first, last
    end
  end
  return nil, t.line, t.endLine
end

local function compose_for(t, title, key, text, on_submit)
  local buf = where(t)
  if not buf or vim.fn.bufwinid(buf) == -1 then
    M.show(t.path, t.endLine)
    buf = vim.api.nvim_get_current_buf()
  end
  local _, _, last = where(t)
  compose.open {
    win = vim.fn.bufwinid(buf),
    buf = buf,
    lnum = last + 1,
    title = title,
    key = key,
    text = text,
    on_submit = on_submit,
  }
end

--- Comment on the lines first..last (1-based; default the cursor line) of
--- the current buffer: a new thread there.
function M.comment(first, last)
  with_review(function()
    local buf = vim.api.nvim_get_current_buf()
    local path = M.path_of(buf)
    if not path then
      notify('not a work-tree file: no comments here', 'warn')
      return
    end
    first = first or vim.api.nvim_win_get_cursor(0)[1]
    last = last or first
    local label = first == last and ('L%d'):format(first) or ('L%d–%d'):format(first, last)
    compose.open {
      win = vim.api.nvim_get_current_win(),
      buf = buf,
      lnum = last,
      title = 'Comment · ' .. vim.fn.fnamemodify(path, ':t') .. ' ' .. label,
      key = ('new:%s:%d'):format(path, first),
      on_submit = function(body)
        call('POST', '/v1/comments', { path = path, line = first - 1, endLine = last - 1, body = body, author = author(), source = 'human' }, function()
          M.refresh()
        end)
      end,
    }
  end)
end

--- Reply to a thread (default: the one on the cursor line, or the panel's).
function M.reply(t)
  if not t then
    if M._panel_thread and M._panel_thread() then
      return M.reply(M._panel_thread())
    end
    return thread_here('Reply to which thread?', M.reply)
  end
  compose_for(t, 'Reply · ' .. cards.loc(t), 'reply:' .. t.id, nil, function(body)
    local buf, first, last = where(t)
    local path = buf and M.path_of(buf) or t.path
    call('POST', '/v1/comments/' .. t.id .. '/replies', { path = path, line = first, endLine = last, body = body, author = author(), source = 'human' }, function()
      M.refresh()
    end)
  end)
end

--- Resolve a thread, or reopen a resolved one.
function M.resolve(t)
  if not t then
    if M._panel_thread and M._panel_thread() then
      return M.resolve(M._panel_thread())
    end
    return thread_here('Resolve or reopen which thread?', M.resolve)
  end
  t = thread_by_id(t.id) or t
  call('PUT', '/v1/comments/' .. t.id .. '/resolved', { resolved = t.status ~= 'resolved' }, function()
    M.refresh()
  end)
end

local function comment_label(c)
  return (c.author or '?') .. ': ' .. cards.first_line(c.body)
end

--- Edit one of your comments of the thread on the cursor line.
function M.edit()
  thread_here('Edit a comment of which thread?', function(t)
    choose(t.comments, 'Edit which comment?', comment_label, function(c)
      compose_for(t, 'Edit · ' .. cards.loc(t), 'edit:' .. c.id, c.body, function(body)
        call('PATCH', '/v1/comments/' .. c.id, { body = body }, function()
          M.refresh()
        end)
      end)
    end)
  end)
end

--- Delete a comment of the thread on the cursor line (its first: the thread).
function M.delete()
  thread_here('Delete from which thread?', function(t)
    choose(t.comments, 'Delete which comment? (the first deletes the thread)', comment_label, function(c)
      local what = c.id == t.id and ('the thread (%d comments)'):format(#t.comments) or 'this comment'
      if vim.fn.confirm('Delete ' .. what .. '?', '&Delete\n&Cancel', 2) == 1 then
        call('DELETE', '/v1/comments/' .. c.id, nil, function()
          M.refresh()
        end)
      end
    end)
  end)
end

--- The overall comment, written in a composer.
function M.overall()
  with_review(function()
    local win = M.code_window() or vim.api.nvim_get_current_win()
    local buf = vim.api.nvim_win_get_buf(win)
    compose.open {
      win = win,
      buf = buf,
      lnum = vim.api.nvim_win_get_cursor(win)[1],
      title = 'Overall comment',
      key = 'overall',
      text = state.overall,
      on_submit = function(body)
        call('PUT', '/v1/overall', { overall = body }, function()
          M.refresh()
        end)
      end,
    }
  end)
end

--- The next (dir = 1) or previous (-1) unresolved thread of the review,
--- across files, from the cursor.
function M.jump(dir)
  local threads = vim.tbl_filter(function(t)
    return t.status ~= 'resolved'
  end, M.threads())
  if #threads == 0 then
    notify 'no open threads'
    return
  end
  local path = M.path_of(vim.api.nvim_get_current_buf())
  local line = vim.api.nvim_win_get_cursor(0)[1] - 1
  local function pos(t)
    local buf, first = where(t)
    return buf and M.path_of(buf) == t.path and first or t.line
  end
  local target
  if dir > 0 then
    for _, t in ipairs(threads) do
      if path and (t.path > path or (t.path == path and pos(t) > line)) then
        target = t
        break
      end
    end
    target = target or threads[1]
  else
    for i = #threads, 1, -1 do
      local t = threads[i]
      if path and (t.path < path or (t.path == path and pos(t) < line)) then
        target = t
        break
      end
    end
    target = target or threads[#threads]
  end
  M.show(target.path, pos(target))
end

-- Setup ------------------------------------------------------------------------------------

function M.setup(opts)
  M.config = vim.tbl_deep_extend('force', M.config, opts or {})
  M._setup = true
  return M
end

vim.api.nvim_create_autocmd({ 'BufReadPost', 'BufWinEnter', 'BufFilePost' }, {
  group = group,
  callback = function(ev)
    if not state.root then
      return
    end
    if ev.event == 'BufReadPost' and state.bufs[ev.buf] then
      -- :e! read the file again: the review's places, not the old marks.
      undecorate(ev.buf)
    end
    if M.path_of(ev.buf) or state.bufs[ev.buf] then
      M.decorate(ev.buf)
    end
  end,
})
vim.api.nvim_create_autocmd('BufWipeout', {
  group = group,
  callback = function(ev)
    if state.bufs[ev.buf] then
      undecorate(ev.buf)
    end
  end,
})
vim.api.nvim_create_autocmd('DirChanged', {
  group = group,
  callback = function()
    if M.config.auto_attach and not state.client then
      M.attach { no_start = true, quiet = true }
    end
  end,
})

return M
