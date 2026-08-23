#!/bin/sh
# Fake login shell for NodeProcessGateway PATH-priming tests.
#
# Mimics a real `$SHELL -lic <command>` invocation on a machine whose rc files
# are noisy: it prints noise BEFORE and AFTER the command output (like nvm in
# .zprofile and a farewell in .zlogout), prepends fake directories to PATH the
# way a login shell would, and then evaluates the requested command so marker
# strings round-trip exactly as the production code constructs them.
echo "nvm: loading environment"
if [ "$1" = "-lic" ] || [ "$1" = "-lc" ]; then
  if [ "$1" = "-lic" ]; then
    # Represents a version manager activated only from an interactive rc file.
    PATH="/fake-login-dir/bin:/fake-login-dir/sbin:$PATH"
    export PATH
  fi
  eval "$2"
fi
echo "zlogout: goodbye"
