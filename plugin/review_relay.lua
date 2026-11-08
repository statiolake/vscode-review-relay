-- :ReviewRelay — Review Relay in Neovim (lua/review_relay). Loading the
-- module waits for the first use, except that a review already running for
-- the directory is joined at startup (auto_attach), so its threads show.
if vim.g.loaded_review_relay then
  return
end
vim.g.loaded_review_relay = true

local subcommands = {
  comment = function(o)
    local rr = require 'review_relay'
    if o.range > 0 then
      rr.comment(o.line1, o.line2)
    else
      rr.comment()
    end
  end,
  reply = function()
    require('review_relay').reply()
  end,
  resolve = function()
    require('review_relay').resolve()
  end,
  edit = function()
    require('review_relay').edit()
  end,
  delete = function()
    require('review_relay').delete()
  end,
  overall = function()
    require('review_relay').overall()
  end,
  next = function()
    require('review_relay').jump(1)
  end,
  prev = function()
    require('review_relay').jump(-1)
  end,
  refresh = function()
    require('review_relay').refresh()
  end,
  stop = function()
    require('review_relay').detach()
  end,
}

vim.api.nvim_create_user_command('ReviewRelay', function(o)
  local sub = subcommands[o.fargs[1]]
  if sub and #o.fargs == 1 then
    return sub(o)
  end
  if #o.fargs > 0 then
    return vim.notify(('review-relay: unknown subcommand %q'):format(table.concat(o.fargs, ' ')), vim.log.levels.ERROR)
  end
  -- :ReviewRelay: the panel, joining the review running for the directory
  -- or starting one.
  local rr = require 'review_relay'
  rr.attach({}, function(ok)
    if ok then
      require('review_relay.panel').toggle_focus()
    end
  end)
end, {
  nargs = '?',
  range = true,
  complete = function(lead)
    local items = vim.tbl_keys(subcommands)
    table.sort(items)
    return vim.tbl_filter(function(item)
      return item:sub(1, #lead) == lead
    end, items)
  end,
  desc = 'Review Relay: the panel, or comment / reply / resolve / edit / delete / overall / next / prev / refresh / stop',
})

-- Join a review already running for the directory, once Neovim is up (at
-- once when the plugin is loaded later, e.g. lazy.nvim's VeryLazy).
local function join()
  local rr = require 'review_relay'
  if rr.config.auto_attach then
    rr.attach { no_start = true, quiet = true }
  end
end
if vim.v.vim_did_enter == 1 then
  vim.schedule(join)
else
  vim.api.nvim_create_autocmd('VimEnter', {
    group = vim.api.nvim_create_augroup('review_relay_start', { clear = true }),
    once = true,
    callback = join,
  })
end
