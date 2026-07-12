#!/bin/sh
# Fake login shell for NodeProcessGateway PATH-priming tests.
#
# Mimics a real `$SHELL -lc <command>` invocation on a machine whose rc files
# are noisy: it prints noise BEFORE and AFTER the command output (like nvm in
# .zprofile and a farewell in .zlogout), prepends fake directories to PATH the
# way a login shell would, and then evaluates the requested command so marker
# strings round-trip exactly as the production code constructs them.
echo "nvm: loading environment"
PATH="/fake-login-dir/bin:/fake-login-dir/sbin:$PATH"
export PATH
if [ "$1" = "-lc" ]; then
  eval "$2"
fi
echo "zlogout: goodbye"
