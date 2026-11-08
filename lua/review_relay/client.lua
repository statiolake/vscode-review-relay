-- require('review_relay.client'): one review, through `review-relay attach`.
--
-- The review is review-relay's (its server keeps, validates and stores the
-- threads); this is a pipe to it. `review-relay attach` is a child process
-- speaking JSON lines: it uses the review already running for the directory
-- or runs one (no window) until this job ends, carries the HTTP API
-- (request) and its events (state, navigate), and reaches the next review
-- by itself when the one it uses goes away (a new `attached`). No HTTP
-- client, discovery or lifecycle lives in Lua.

local Client = {}
Client.__index = Client

--- Start attaching. opts:
---   cmd        the review-relay executable
---   dir        the directory whose review it is
---   diff_args  git diff arguments for a review it starts (nil: the files)
---   no_start   only use a review that is already running
---   on_attached(info)  { endpoint, root, owner, session }; again after a reconnect
---   on_event(name, data)
---   on_exit(message)   the attach ended (message: why, when it failed)
function Client.start(opts)
  local self = setmetatable({ opts = opts, pending = {}, next_id = 1, partial = '', stderr = {} }, Client)
  local argv = { opts.cmd, 'attach', '--workspace', opts.dir }
  if opts.no_start then
    table.insert(argv, '--no-start')
  end
  if opts.diff_args then
    table.insert(argv, '--')
    vim.list_extend(argv, opts.diff_args)
  end
  local ok, job = pcall(vim.fn.jobstart, argv, {
    on_stdout = function(_, data)
      self:_receive(data)
    end,
    on_stderr = function(_, data)
      for _, line in ipairs(data) do
        if line ~= '' then
          table.insert(self.stderr, line)
        end
      end
    end,
    on_exit = function(_, code)
      vim.schedule(function()
        self.job = nil
        local message = self.error
        if not message and code ~= 0 and not self.stopping then
          message = ('review-relay attach exited (%d)%s'):format(code, #self.stderr > 0 and (': ' .. table.concat(self.stderr, ' ')) or '')
        end
        for _, cb in pairs(self.pending) do
          cb(false, { error = message or 'the review is closed' }, 0)
        end
        self.pending = {}
        if opts.on_exit then
          opts.on_exit(message)
        end
      end)
    end,
  })
  if not ok or job <= 0 then
    vim.schedule(function()
      if opts.on_exit then
        opts.on_exit(('cannot run %s: is it built? (:Lazy build vscode-review-relay)'):format(opts.cmd))
      end
    end)
    return self
  end
  self.job = job
  return self
end

local function decode(text)
  local ok, value = pcall(vim.json.decode, text, { luanil = { object = true, array = true } })
  return ok and type(value) == 'table' and value or nil
end
Client._decode = decode

function Client:_receive(data)
  -- Job output arrives in chunks that end mid-line: the first piece
  -- continues the last line, the last piece is the start of the next.
  data[1] = self.partial .. data[1]
  self.partial = table.remove(data)
  for _, line in ipairs(data) do
    local message = line ~= '' and decode(line) or nil
    if message then
      vim.schedule(function()
        self:_handle(message)
      end)
    end
  end
end

function Client:_handle(message)
  local opts = self.opts
  if message.type == 'attached' then
    self.info = { endpoint = message.endpoint, root = message.root, owner = message.owner == true, session = message.session or {} }
    if opts.on_attached then
      opts.on_attached(self.info)
    end
  elseif message.type == 'response' then
    local cb = self.pending[message.id]
    self.pending[message.id] = nil
    if cb then
      local status = message.status or 0
      cb(status >= 200 and status < 300, message.body or {}, status)
    end
  elseif message.type == 'event' then
    if opts.on_event then
      opts.on_event(message.name, message.data)
    end
  elseif message.type == 'error' then
    self.error = message.message
  end
end

--- An API request. cb(ok, body, status) on the main loop; body.error says
--- why when not ok.
function Client:request(method, path, body, cb)
  cb = cb or function() end
  if not self.job then
    vim.schedule(function()
      cb(false, { error = 'the review is closed' }, 0)
    end)
    return
  end
  local id = self.next_id
  self.next_id = id + 1
  self.pending[id] = cb
  local line = { id = id, method = method, path = path }
  if body ~= nil then
    line.body = body
  end
  vim.fn.chansend(self.job, vim.json.encode(line) .. '\n')
end

function Client:running()
  return self.job ~= nil
end

--- Detach: attach stops a review it runs once its stdin closes.
function Client:stop()
  if self.job then
    self.stopping = true
    pcall(vim.fn.chanclose, self.job, 'stdin')
  end
end

return Client
