-- require('review_relay.cards'): how a thread looks.
--
-- In DevHub's GUI a thread is a card (devhub.nvim's gui.ui components) under
-- its last line: who wrote what (markdown), and Reply / Resolve buttons that
-- carry their keys, so nothing is mouse-only. Elsewhere the same thread is
-- Neovim's own virt_lines: the same words, in highlight groups.

local M = {}

local LABELS = { waiting = 'Waiting for AI', answered = 'AI replied', resolved = 'Resolved' }
M.LABELS = LABELS

function M.tone(config, status)
  local c = config.colors
  return status == 'waiting' and c.waiting or status == 'answered' and c.agent or c.resolved
end

function M.range_label(t)
  if t.endLine ~= t.line then
    return ('L%d–%d'):format(t.line + 1, t.endLine + 1)
  end
  return ('L%d'):format(t.line + 1)
end

function M.loc(t)
  return vim.fn.fnamemodify(t.path, ':t') .. ':' .. M.range_label(t):sub(2)
end

function M.first_line(text)
  return ((text or ''):gsub('\n.*', ''):gsub('`', ''))
end

-- RFC 3339 to seconds since the epoch.
local function epoch(stamp)
  local y, mo, d, h, mi, s, rest = (stamp or ''):match '^(%d+)-(%d+)-(%d+)T(%d+):(%d+):(%d+)[%.%d]*(.*)$'
  if not y then
    return nil
  end
  local t = os.time { year = y, month = mo, day = d, hour = h, min = mi, sec = s, isdst = false }
  t = t + (os.time() - os.time(os.date '!*t'))
  local sign, oh, om = rest:match '^([+-])(%d+):(%d+)$'
  if sign then
    t = t - (sign == '+' and 1 or -1) * (oh * 3600 + om * 60)
  end
  return t
end

function M.ago(stamp, now)
  local t = epoch(stamp)
  if not t then
    return ''
  end
  local d = math.max(0, (now or os.time()) - t)
  if d < 60 then
    return 'just now'
  elseif d < 3600 then
    return math.floor(d / 60) .. ' min ago'
  elseif d < 86400 then
    return math.floor(d / 3600) .. ' h ago'
  end
  return math.floor(d / 86400) .. ' d ago'
end

local function is_agent(c)
  return c.source == 'agent'
end
M.is_agent = is_agent

function M.avatar(ui, config, c)
  return ui.avatar(c.author or '?', { tone = is_agent(c) and config.colors.agent or config.colors.human, size = 20 })
end

--- A thread as a card. actions: { reply = fn, resolve = fn }. A resolved
--- thread folds to one line with Reopen.
function M.card(ui, config, t, actions)
  actions = actions or {}
  local keys = config.thread_keys or {}
  if t.status == 'resolved' then
    return ui.hstack {
      card = true,
      pad = { 4, 12 },
      gap = 8,
      ui.text({ { '✓ Resolved', bold = true } }, { tone = config.colors.ok }),
      ui.text(M.range_label(t), { mono = true, dim = true, size = 'sm' }),
      ui.text(M.first_line(t.root.body), { grow = true, dim = true }),
      ui.text(#t.comments > 1 and ('+' .. (#t.comments - 1)) or '', { dim = true, size = 'sm' }),
      ui.button('Reopen', { key = keys.resolve or nil, on_click = actions.resolve }),
    }
  end
  local children = {
    ui.hstack {
      gap = 8,
      ui.text(M.range_label(t), { mono = true, dim = true, size = 'sm' }),
      ui.badge(LABELS[t.status], { tone = M.tone(config, t.status) }),
      ui.spacer(),
      ui.text(#t.comments == 1 and '1 comment' or (#t.comments .. ' comments'), { dim = true, size = 'sm' }),
    },
  }
  for index, c in ipairs(t.comments) do
    if index > 1 then
      table.insert(children, ui.divider())
    end
    table.insert(
      children,
      ui.hstack {
        align = 'start',
        gap = 10,
        M.avatar(ui, config, c),
        ui.stack {
          grow = true,
          gap = 2,
          ui.hstack {
            gap = 7,
            ui.text { { c.author or '?', bold = true } },
            ui.badge(is_agent(c) and 'agent' or 'you', { tone = is_agent(c) and config.colors.agent or config.colors.human }),
            ui.text(M.ago(c.createdAt), { dim = true, size = 'sm' }),
          },
          ui.md(c.body or ''),
        },
      }
    )
  end
  table.insert(
    children,
    ui.hstack {
      pad = { 2, 0 },
      ui.spacer(30),
      ui.button('Reply', { icon = '↩', key = keys.reply or nil, on_click = actions.reply }),
      ui.spacer(),
      ui.button('Resolve', { icon = '✓', key = keys.resolve or nil, tone = config.colors.ok, on_click = actions.resolve }),
    }
  )
  children.card = true
  children.gap = 8
  children.pad = { 8, 12 }
  return ui.stack(children)
end

--- The same thread as virt_lines (outside DevHub's GUI): a header, each
--- comment's author and body, and the keys.
function M.virt_lines(config, t, indent)
  local pad = string.rep(' ', indent or 0)
  local tone = M.tone(config, t.status)
  local keys = config.thread_keys or {}
  if t.status == 'resolved' then
    return { { { pad .. '✓ Resolved  ', config.colors.ok }, { M.first_line(t.root.body), 'Comment' } } }
  end
  local lines = { { { pad .. '┌ ', 'Comment' }, { LABELS[t.status], tone } } }
  for _, c in ipairs(t.comments) do
    table.insert(lines, {
      { pad .. '│ ', 'Comment' },
      { c.author or '?', is_agent(c) and config.colors.agent or config.colors.human },
      { ' · ' .. M.ago(c.createdAt), 'Comment' },
    })
    for _, line in ipairs(vim.split(c.body or '', '\n', { plain = true })) do
      table.insert(lines, { { pad .. '│   ', 'Comment' }, { line, 'Normal' } })
    end
  end
  local hint = {}
  if keys.reply then
    table.insert(hint, keys.reply .. ' reply')
  end
  if keys.resolve then
    table.insert(hint, keys.resolve .. ' resolve')
  end
  table.insert(lines, { { pad .. '└ ' .. table.concat(hint, ' · '), 'Comment' } })
  return lines
end

return M
