-- Headless checks of the Neovim frontend against the real core (bin/review-relay).
-- Run by tests/nvim/run.sh (cwd: a fresh git repository with a.txt).
vim.cmd 'runtime plugin/review_relay.lua'
local failures = 0
local function check(name, ok, detail)
  if ok then
    io.stdout:write('ok   ' .. name .. '\n')
  else
    failures = failures + 1
    io.stdout:write('FAIL ' .. name .. (detail and (': ' .. vim.inspect(detail)) or '') .. '\n')
  end
end
local function wait(cond, ms)
  return vim.wait(ms or 5000, cond, 20)
end

-- A stand-in for devhub.nvim's GUI facade: what the frontend asks it to draw.
local inline = {}
local gui_on = false
local ui = setmetatable({}, { __index = function(_, kind)
  return function(a, b) return { type = kind, a = a, b = b } end
end })
package.loaded['devhub'] = {
  gui = {
    available = function() return gui_on end,
    ui = ui,
    notify = function() end,
    inline = function(opts)
      inline[opts.id] = opts
      return { clear = function() inline[opts.id] = nil end }
    end,
    view = function() return { update = function() end } end,
  },
}

local rr = require 'review_relay'
local root = vim.fn.resolve(vim.fn.getcwd())

-- No review runs: auto_attach (--no-start) joins nothing and stays quiet.
wait(function() return false end, 300)
check('auto_attach starts no review', not rr.attached())

local attached
rr.attach({}, function(ok) attached = ok end)
check('attaches, starting a review', wait(function() return attached ~= nil end) and attached and rr._state.root == root, rr._state)

vim.cmd 'edit a.txt'
local buf = vim.api.nvim_get_current_buf()
check('the buffer is the file a.txt', rr.path_of(buf) == 'a.txt')

-- A comment where the cursor is, written in the composer.
vim.api.nvim_win_set_cursor(0, { 2, 0 })
rr.comment()
local composer = vim.api.nvim_get_current_buf()
check('the composer is a markdown buffer in a float', vim.bo[composer].filetype == 'markdown'
  and vim.api.nvim_win_get_config(0).relative == 'win')
vim.api.nvim_buf_set_lines(composer, 0, -1, false, { 'Why two?', '', 'Explain.' })
vim.cmd 'stopinsert'
vim.cmd 'write'
check('sent, a thread on line 2', wait(function() return #rr._state.comments == 1 end)
  and rr._state.comments[1].line == 1 and rr._state.comments[1].body == 'Why two?\n\nExplain.'
  and rr._state.comments[1].source == 'human' and rr._state.comments[1].author == 'Tester', rr._state.comments)
check('back in the file', vim.api.nvim_get_current_buf() == buf)
local root_id = rr._state.comments[1] and rr._state.comments[1].id

-- Plain Neovim: the thread is virt_lines and a sign, its keys on its lines.
local function virt_rows()
  local n = 0
  for _, m in ipairs(vim.api.nvim_buf_get_extmarks(buf, -1, 0, -1, { details = true })) do
    if m[4].virt_lines then n = n + #m[4].virt_lines end
  end
  return n
end
check('shown as virt_lines outside DevHub', wait(function() return virt_rows() > 0 end))
check('r is mapped on the thread line only', (function()
  local m = vim.fn.maparg('r', 'n', false, true)
  return m.buffer == 1 and m.expr == 1
end)())
check('one thread at line 2, none at line 4', #rr.threads_at(buf, 2) == 1 and #rr.threads_at(buf, 4) == 0)

-- An edit above moves the thread; the review is told.
vim.api.nvim_buf_set_lines(buf, 0, 0, false, { 'zero' })
vim.cmd 'doautocmd TextChanged'
local polls = 0
check('the move reached the review', vim.wait(8000, function()
  polls = polls + 1
  if polls % 10 == 0 then
    rr.refresh()
  end
  return rr._state.comments[1] and rr._state.comments[1].line == 2
end, 20), rr._state.comments)

-- Another client (an agent through the CLI) replies: it shows here.
local cli = rr.executable()
local reply_out = vim.fn.system { cli, '--workspace', root, 'comments', 'reply', root_id, '--path', 'a.txt', '--line', '2', '--body', 'Because.' }
check('an agent reply arrives by the event stream', wait(function() return #rr._state.comments == 2 end), { reply_out, vim.fn.glob(vim.env.TMPDIR .. '/vscode-review-relay/sessions/*', false, true), rr._state.client and rr._state.client.stderr, vim.fn.system { cli, '--workspace', root, 'health' } })
local t = rr.threads()[1]
check('the thread is answered', t and t.status == 'answered')

-- An agent starts a thread of its own (from a subdirectory: the CLI finds
-- the review containing it), and sends the editor there.
vim.fn.mkdir(root .. '/sub', 'p')
local add_out = vim.fn.system { cli, '--workspace', root .. '/sub', 'comments', 'add', '--path', 'a.txt', '--line', '4', '--body', 'And five?', '--author', 'Claude' }
check('an agent comment shows at once', wait(function() return #rr.threads() == 2 end), add_out)
check('on its line, as the agent\'s', #rr.threads_at(buf, 5) == 1 and rr.threads_at(buf, 5)[1].root.source == 'agent', rr.threads())
vim.api.nvim_win_set_cursor(0, { 1, 0 })
local agent_id = vim.json.decode(add_out).comment.id
vim.fn.system { cli, '--workspace', root, 'navigate', '--comment', agent_id }
check('navigate moves the cursor to it', wait(function() return vim.api.nvim_win_get_cursor(0)[1] == 5 end), vim.api.nvim_win_get_cursor(0))

-- Resolve from the thread's line.
vim.api.nvim_win_set_cursor(0, { 3, 0 })
rr.resolve()
check('resolved', wait(function() return rr.threads()[1] and rr.threads()[1].status == 'resolved' end))

-- A buffer in diff mode is still the file: the thread shows there too.
vim.cmd 'diffthis'
vim.cmd 'vnew'
vim.api.nvim_buf_set_lines(0, 0, -1, false, { 'one', 'two' })
vim.cmd 'diffthis'
local scratch = vim.api.nvim_get_current_buf()
check('a scratch buffer is no file of the review', rr.path_of(scratch) == nil)
local warned
local notify = vim.notify
vim.notify = function(msg) warned = msg end
rr.comment()
vim.notify = notify
check('and refuses a comment, saying why', warned and warned:find 'not a work%-tree file' ~= nil, warned)
vim.cmd 'wincmd p'
check('the diff-mode file buffer keeps its thread', vim.wo.diff and #rr.threads_at(buf, 3) == 1)
vim.cmd 'diffoff!'
vim.cmd('bwipe! ' .. scratch)

-- In DevHub's GUI the thread is a card under its last line.
gui_on = true
rr.decorate(buf)
local card = inline['review-relay:' .. root_id]
check('a card under the thread in DevHub', card and card.buf == buf and card.lnum == 3, card)
gui_on = false
rr.decorate(buf)

-- The panel is a buffer of text lines.
require('review_relay.panel').toggle_focus()
local lines = vim.api.nvim_buf_get_lines(0, 0, -1, false)
check('the panel lists the thread', vim.tbl_contains(lines, 'a.txt:3 [Resolved] Why two?'), lines)
check('and the file that has threads', vim.tbl_contains(lines, 'a.txt  2'), lines)
vim.cmd 'close'

-- The review is comments only: :ReviewRelay takes no diff.
local refused
vim.notify = function(msg) refused = msg end
vim.cmd 'ReviewRelay HEAD~'
vim.notify = notify
check(':ReviewRelay HEAD~ is refused', refused and refused:find 'unknown subcommand' ~= nil, refused)

-- Leaving stops the review this Neovim ran.
rr.detach()
local alive = vim.fn.system { cli, '--workspace', root, 'health' }
check('the review stops with the last client', wait(function()
  vim.fn.system { cli, '--workspace', root, 'health' }
  return vim.v.shell_error ~= 0
end), alive)

io.stdout:write(failures == 0 and 'all passed\n' or (failures .. ' failed\n'))
vim.cmd(failures == 0 and 'qa!' or 'cq!')
