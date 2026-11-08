-- require('review_relay.panel'): the review panel.
--
-- A buffer, one line per item (the files, the filter, the threads, the
-- overall comment) — so `/`, counts, marks and macros work on it — which
-- DevHub's GUI draws as components (gui.view). Elsewhere it is that text.
-- Keys: <CR> open, r reply, s resolve, f filter, o overall comment,
-- R refresh, q close.

local rr = require 'review_relay'
local cards = require 'review_relay.cards'

local M = {}

local panel = { buf = nil, view = nil, entries = {}, filter = 'all', collapsed = {} }
M._panel = panel

local function counts(threads)
  local c = { waiting = 0, answered = 0, resolved = 0 }
  for _, t in ipairs(threads) do
    c[t.status] = c[t.status] + 1
  end
  return c
end

--- The panel's entries: { text = its buffer line, node = fn(ui), kind, … }.
function M.entries()
  local state = rr._state
  local config = rr.config
  local entries = {}
  local function add(e)
    table.insert(entries, e)
  end
  local threads = rr.threads()
  local by_path = {}
  for _, t in ipairs(threads) do
    by_path[t.path] = by_path[t.path] or {}
    table.insert(by_path[t.path], t)
  end
  add {
    kind = 'header',
    text = 'Review  ' .. vim.fn.fnamemodify(state.root or '', ':t'),
    node = function(ui)
      return ui.hstack {
        gap = 8,
        pad = { 6, 2 },
        ui.text('Review', { size = 'lg', bold = true, tone = 'title' }),
        ui.spacer(),
        ui.text(vim.fn.fnamemodify(state.root or '', ':t'), { dim = true, size = 'sm' }),
      }
    end,
  }
  -- The files that have threads.
  local files = {}
  for path in pairs(by_path) do
    table.insert(files, { path = path })
  end
  table.sort(files, function(a, b)
    return a.path < b.path
  end)
  add {
    kind = 'section',
    text = 'FILES',
    node = function(ui)
      return ui.hstack { pad = { 6, 2 }, ui.text('Files', { dim = true }), ui.spacer(), ui.text('threads', { dim = true, size = 'xs' }) }
    end,
  }
  local dirs, order = {}, {}
  for _, f in ipairs(files) do
    local dir = f.path:match '^(.*)/[^/]+$' or ''
    if not dirs[dir] then
      dirs[dir] = {}
      table.insert(order, dir)
    end
    table.insert(dirs[dir], f)
  end
  table.sort(order, function(a, b)
    if (a == '') ~= (b == '') then
      return a ~= ''
    end
    return a < b
  end)
  for _, dir in ipairs(order) do
    local list = dirs[dir]
    local indent = 0
    if dir ~= '' then
      local open = not panel.collapsed[dir]
      add {
        kind = 'dir',
        dir = dir,
        text = (open and '▾ ' or '▸ ') .. dir .. '/',
        node = function(ui)
          return ui.hstack {
            gap = 8,
            pad = { 3, 2 },
            ui.text((open and '▾ ' or '▸ ') .. dir, { dim = true, grow = true }),
          }
        end,
      }
      indent = 22
      if not open then
        list = {}
      end
    end
    for _, f in ipairs(list) do
      local name = dir ~= '' and f.path:sub(#dir + 2) or f.path
      local c = counts(by_path[f.path] or {})
      local n = c.waiting + c.answered + c.resolved
      add {
        kind = 'file',
        file = f,
        text = (dir ~= '' and '  ' or '') .. f.path .. (n > 0 and ('  ' .. n) or ''),
        node = function(ui)
          local row = { gap = 8, pad = { 3, 2 }, indent = indent }
          table.insert(row, ui.text(name, { grow = true }))
          for _, s in ipairs { 'waiting', 'answered', 'resolved' } do
            if c[s] > 0 then
              table.insert(row, ui.pill(c[s], { tone = cards.tone(config, s) }))
            end
          end
          return ui.hstack(row)
        end,
      }
    end
  end
  local c = counts(threads)
  local filters = { { 'waiting', 'Waiting', c.waiting }, { 'answered', 'Answered', c.answered }, { 'all', 'All', #threads } }
  add {
    kind = 'filter',
    text = ('Waiting %d · Answered %d · All %d'):format(c.waiting, c.answered, #threads),
    node = function(ui)
      local segs = { gap = 4, pad = { 8, 0 } }
      for _, f in ipairs(filters) do
        local on = panel.filter == f[1]
        table.insert(segs, ui.hstack {
          grow = true,
          justify = 'center',
          gap = 4,
          pad = { 3, 0 },
          bg = on and 'CursorLine' or nil,
          on_click = function()
            M.set_filter(f[1])
          end,
          ui.text(f[2], { bold = on or nil, dim = not on or nil }),
          ui.text(tostring(f[3]), { dim = true, size = 'sm' }),
        })
      end
      return ui.hstack(segs)
    end,
  }
  for _, t in ipairs(threads) do
    if panel.filter == 'all' or panel.filter == t.status then
      add {
        kind = 'thread',
        thread = t,
        text = ('%s [%s] %s'):format(cards.loc(t), cards.LABELS[t.status], cards.first_line(t.root.body)),
        node = function(ui)
          local who, seen = { gap = 3 }, {}
          for _, cm in ipairs(t.comments) do
            local key = (cm.source or '') .. (cm.author or '')
            if not seen[key] then
              seen[key] = true
              table.insert(who, cards.avatar(ui, config, cm))
            end
          end
          return ui.stack {
            card = true,
            pad = { 7, 12 },
            gap = 3,
            ui.hstack {
              gap = 6,
              ui.text(cards.loc(t), { mono = true, dim = true, size = 'sm' }),
              ui.badge(cards.LABELS[t.status], { tone = cards.tone(config, t.status) }),
              ui.spacer(),
              ui.hstack(who),
            },
            ui.text(cards.first_line(t.root.body), { dim = t.status == 'resolved' or nil }),
          }
        end,
      }
    end
  end
  if #threads == 0 then
    add {
      kind = 'empty',
      text = 'No threads yet',
      node = function(ui)
        return ui.text('No threads yet. :ReviewRelay comment on a line starts one.', { dim = true, wrap = true })
      end,
    }
  end
  add {
    kind = 'overall',
    text = 'Overall: ' .. (state.overall ~= '' and cards.first_line(state.overall) or '(none; o to write)'),
    node = function(ui)
      return ui.stack {
        card = true,
        pad = { 6, 10 },
        gap = 2,
        ui.hstack { ui.text('Overall comment', { dim = true, size = 'sm' }), ui.spacer(), ui.kbd 'o' },
        state.overall ~= '' and ui.md(state.overall) or ui.text('None yet.', { dim = true, size = 'sm' }),
      }
    end,
  }
  return entries
end

local KEYS = {
  { 'j/k', 'move' },
  { '⏎', 'open' },
  { 'r', 'reply' },
  { 's', 'resolve' },
  { 'f', 'filter' },
  { 'o', 'overall' },
  { 'q', 'close' },
}

function M.draw()
  if not panel.buf or not vim.api.nvim_buf_is_valid(panel.buf) then
    return
  end
  panel.entries = M.entries()
  local lines = {}
  for _, e in ipairs(panel.entries) do
    table.insert(lines, e.text)
  end
  vim.bo[panel.buf].modifiable = true
  vim.api.nvim_buf_set_lines(panel.buf, 0, -1, false, lines)
  vim.bo[panel.buf].modifiable = false
  vim.bo[panel.buf].modified = false
  if panel.view then
    panel.view:update()
  end
end

local function entry_at(lnum)
  if vim.api.nvim_get_current_buf() ~= panel.buf then
    return nil
  end
  return panel.entries[lnum or vim.api.nvim_win_get_cursor(0)[1]]
end

-- The thread under the panel's cursor, for r and s there.
rr._panel_thread = function()
  local e = entry_at()
  return e and e.thread or nil
end

function M.set_filter(filter)
  panel.filter = filter
  M.draw()
end

--- Open what is under the cursor: a file, a thread at its line; a
--- directory folds; the filter turns; the overall comment is written.
function M.open(e)
  e = e or entry_at()
  if not e then
    return
  end
  if e.kind == 'file' then
    rr.show(e.file.path)
  elseif e.kind == 'thread' then
    rr.show(e.thread.path, e.thread.endLine)
  elseif e.kind == 'dir' then
    panel.collapsed[e.dir] = not panel.collapsed[e.dir] or nil
    M.draw()
  elseif e.kind == 'filter' then
    M.set_filter(panel.filter == 'all' and 'waiting' or panel.filter == 'waiting' and 'answered' or 'all')
  elseif e.kind == 'overall' then
    rr.overall()
  end
end

--- The panel: opened, or focused when it is open.
function M.toggle_focus()
  if panel.buf and vim.api.nvim_buf_is_valid(panel.buf) then
    local win = vim.fn.bufwinid(panel.buf)
    if win ~= -1 then
      vim.api.nvim_set_current_win(win)
      return
    end
  end
  local buf = panel.buf and vim.api.nvim_buf_is_valid(panel.buf) and panel.buf or vim.api.nvim_create_buf(false, true)
  panel.buf = buf
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'hide'
  vim.bo[buf].swapfile = false
  vim.bo[buf].filetype = 'review-relay'
  pcall(vim.api.nvim_buf_set_name, buf, 'review-relay://panel')
  vim.cmd('botright vertical ' .. rr.config.width .. 'split')
  local win = vim.api.nvim_get_current_win()
  vim.api.nvim_win_set_buf(win, buf)
  for option, value in pairs { number = false, relativenumber = false, signcolumn = 'no', foldcolumn = '0', wrap = false, winfixwidth = true, cursorline = true } do
    vim.wo[win][option] = value
  end
  local g = rr._gui()
  if g and not panel.view then
    panel.view = g.view {
      buf = buf,
      items = function(lnum)
        local e = panel.entries[lnum]
        return e and e.node and e.node(g.ui) or nil
      end,
      keys = KEYS,
      on_click = function(lnum)
        local e = panel.entries[lnum]
        if e and (e.kind == 'dir' or e.kind == 'filter') then
          M.open(e)
        end
      end,
    }
  end
  local function map(lhs, fn, desc)
    vim.keymap.set('n', lhs, fn, { buffer = buf, nowait = true, desc = 'review-relay: ' .. desc })
  end
  map('<CR>', function()
    M.open()
  end, 'open')
  map('r', function()
    rr.reply()
  end, 'reply')
  map('s', function()
    rr.resolve()
  end, 'resolve / reopen')
  map('f', function()
    M.open { kind = 'filter' }
  end, 'filter')
  map('o', function()
    rr.overall()
  end, 'overall comment')
  map('R', function()
    rr.refresh()
  end, 'refresh')
  map('q', function()
    vim.api.nvim_win_close(0, true)
  end, 'close')
  M.draw()
end

rr.on_change(M.draw)

return M
