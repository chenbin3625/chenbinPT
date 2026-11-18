Picomatch patches mitigate GHSA-fc5q-39xc-vjpf until a fixed upstream release is available.
They extend the existing repeated-extglob literalization guard to branches with
unbounded quantifiers, including nested wrappers, while retaining existing safe
simplifications. Complex risky globs are treated literally rather than evaluated.

Run `npm run test:security` after installation. It checks every locked installation
in a subprocess with a timeout and also verifies ordinary extglob behavior.
Version-only advisory scanners will still report the original package versions.
Remove the patches only after an upstream update passes these checks.
