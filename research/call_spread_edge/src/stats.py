import numpy as np


def block_boot_ci(x, block=8, n=5000, seed=0):
    """Stationary block bootstrap 95% CI of the mean of a time-ordered series."""
    x = np.asarray(x, float); N = len(x)
    if N < 5:
        return (np.nan, np.nan)
    rng = np.random.default_rng(seed); p = 1 / block; m = np.empty(n)
    for i in range(n):
        idx = np.empty(N, int); j = rng.integers(N)
        for t in range(N):
            idx[t] = j
            j = rng.integers(N) if rng.random() < p else (j + 1) % N
        m[i] = x[idx].mean()
    return tuple(np.percentile(m, [2.5, 97.5]))


def trimmed(x, q=0.02):
    x = np.sort(np.asarray(x, float)); c = int(len(x) * q)
    return x[c: len(x) - c].mean() if len(x) > 2 * c else np.nan
