-- lazy.nvim runs this on install and update (`:Lazy build vscode-review-relay`):
-- review-relay, the core this plugin is a frontend of, built into
-- bin/<os>-<arch>/ as the VS Code extension's build puts it (go.mod pins the
-- version). Needs Go.
local root = vim.fn.fnamemodify(debug.getinfo(1, 'S').source:sub(2), ':p:h')
local uname = (vim.uv or vim.loop).os_uname()
local os_name = ({ Linux = 'linux', Darwin = 'darwin', Windows_NT = 'windows' })[uname.sysname] or uname.sysname:lower()
local arch = ({ x86_64 = 'amd64', amd64 = 'amd64', arm64 = 'arm64', aarch64 = 'arm64' })[uname.machine] or uname.machine
local out = table.concat({ root, 'bin', os_name .. '-' .. arch, os_name == 'windows' and 'review-relay.exe' or 'review-relay' }, '/')
if vim.fn.executable 'go' == 0 then
  error 'vscode-review-relay: building review-relay needs Go (https://go.dev/dl/)'
end
vim.fn.mkdir(vim.fn.fnamemodify(out, ':h'), 'p')
local output = {}
local collect = function(_, data)
  vim.list_extend(output, data)
end
local job = vim.fn.jobstart({ 'go', 'build', '-trimpath', '-ldflags=-s -w', '-o', out, 'github.com/statiolake/review-relay' }, {
  cwd = root,
  env = { CGO_ENABLED = '0' }, -- no window: everything an editor uses, built anywhere
  on_stdout = collect,
  on_stderr = collect,
})
if job <= 0 or vim.fn.jobwait({ job }, 10 * 60 * 1000)[1] ~= 0 then
  error('vscode-review-relay: go build failed: ' .. table.concat(output, '\n'))
end
print('vscode-review-relay: built ' .. out)
