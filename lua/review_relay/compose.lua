-- require('review_relay.compose'): where a comment is written.
--
-- A real Neovim buffer (markdown) in a float right under the thread — under
-- the rows its card takes — so the conversation stays in view while you
-- write, and writing is Neovim's: its modes, undo, completion, IME. Sent
-- with <C-s> or :w; q (Normal) or :q drops it. Leaving the float keeps
-- the draft for the next time the same thread is answered.

local M = {}

local drafts = {}

-- Rows other plugins (a card, a diff's filler) reserve under a line:
-- every namespace's virt_lines below it.
local function rows_under(buf, row)
  local ok, marks = pcall(vim.api.nvim_buf_get_extmarks, buf, -1, { row, 0 }, { row, -1 }, { details = true })
  local rows = 0
  for _, mark in ipairs(ok and marks or {}) do
    local d = mark[4] or {}
    if d.virt_lines and not d.virt_lines_above then
      rows = rows + #d.virt_lines
    end
  end
  return rows
end

--- Open a composer. opts:
---   win, buf, lnum   where it goes: under line lnum (1-based) of buf in win
---   title            what it answers ('Reply · store.go L41')
---   key              a draft key ('reply:<id>', 'new:<path>:<line>')
---   text             the starting text (an edit), else the draft
---   on_submit(body)  with the text, trimmed and not empty
function M.open(opts)
  local win = opts.win
  if not (win and vim.api.nvim_win_is_valid(win)) then
    win = vim.api.nvim_get_current_win()
  end
  local height = 6
  local info = vim.fn.getwininfo(win)[1] or { textoff = 0, width = vim.api.nvim_win_get_width(win) }
  local width = math.max(30, math.min(info.width - info.textoff - 2, 92))
  local rows = rows_under(opts.buf, opts.lnum - 1)
  -- Keep the line, its card and the composer in sight.
  vim.api.nvim_win_call(win, function()
    pcall(vim.api.nvim_win_set_cursor, win, { opts.lnum, 0 })
    local room = vim.api.nvim_win_get_height(win)
    if vim.fn.winline() + rows + height + 2 > room then
      local view = vim.fn.winsaveview()
      view.topline = math.max(1, opts.lnum - math.max(0, room - rows - height - 3))
      vim.fn.winrestview(view)
    end
  end)

  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].buftype = 'acwrite'
  vim.bo[buf].bufhidden = 'wipe'
  vim.bo[buf].swapfile = false
  vim.bo[buf].filetype = 'markdown'
  pcall(vim.api.nvim_buf_set_name, buf, 'review-relay://' .. (opts.key or 'comment'))
  local text = opts.text or drafts[opts.key]
  if text and text ~= '' then
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, vim.split(text, '\n', { plain = true }))
  end
  vim.bo[buf].modified = false

  local config = {
    relative = 'win',
    win = win,
    bufpos = { opts.lnum - 1, 0 },
    row = 1 + rows,
    -- With bufpos, col counts from the text's first column: the border
    -- sits in the gutter's last cell and the text lines up with the code.
    col = -1,
    width = width,
    height = height,
    border = 'rounded',
    style = 'minimal',
    title = ' ' .. opts.title .. ' ',
    title_pos = 'left',
    zindex = 60,
  }
  if vim.fn.has 'nvim-0.10' == 1 then
    config.footer = ' <C-s> / :w send · q / :q cancel '
    config.footer_pos = 'right'
  end
  local float = vim.api.nvim_open_win(buf, true, config)
  vim.wo[float].wrap = true
  vim.wo[float].linebreak = true

  local done = false
  local function close()
    if vim.api.nvim_win_is_valid(float) then
      vim.api.nvim_win_close(float, true)
    end
  end
  local function lines()
    return table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), '\n')
  end
  local function submit()
    if done then
      return
    end
    local body = vim.trim(lines())
    done = true
    vim.cmd 'stopinsert'
    close()
    if opts.key then
      drafts[opts.key] = nil
    end
    if body ~= '' then
      opts.on_submit(body)
    end
  end
  local function cancel()
    done = true
    if opts.key then
      drafts[opts.key] = nil
    end
    close()
  end
  local map = function(modes, lhs, fn, desc)
    vim.keymap.set(modes, lhs, fn, { buffer = buf, nowait = true, desc = 'review-relay: ' .. desc })
  end
  map({ 'n', 'i' }, '<C-s>', submit, 'send')
  map('n', 'q', cancel, 'cancel')
  vim.api.nvim_create_autocmd('BufWriteCmd', { buffer = buf, callback = submit })
  vim.api.nvim_create_autocmd('QuitPre', {
    buffer = buf,
    callback = function()
      done = true -- :q drops it
      if opts.key then
        drafts[opts.key] = nil
      end
    end,
  })
  vim.api.nvim_create_autocmd('WinLeave', {
    buffer = buf,
    once = true,
    callback = function()
      if not done and opts.key and vim.trim(lines()) ~= '' then
        drafts[opts.key] = lines()
      end
      vim.schedule(close)
    end,
  })
  vim.cmd 'startinsert!'
  return { buf = buf, win = float, submit = submit, cancel = cancel }
end

M._drafts = drafts
return M
