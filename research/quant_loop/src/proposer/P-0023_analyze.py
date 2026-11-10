"""P-0023 training analysis: thin wrapper around P-0023_0024_stats.py (signal ivol).
Time wall inside the stats script: entry and exit < 2023-10-31 (first step after reading)."""
import os, runpy, sys
sys.argv = [sys.argv[0], "ivol"]
runpy.run_path(os.path.join(os.path.dirname(os.path.abspath(__file__)), "P-0023_0024_stats.py"), run_name="__main__")
