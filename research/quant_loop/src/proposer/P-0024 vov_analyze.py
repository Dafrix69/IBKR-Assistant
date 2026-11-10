"""P-0024 vov training analysis: thin wrapper around P-0023_0024_stats.py (signal ). Time wall inside: entry and exit < 2023-10-31."""
import os, runpy, sys
sys.argv = [sys.argv[0], ""]
runpy.run_path(os.path.join(os.path.dirname(os.path.abspath(__file__)), "P-0023_0024_stats.py"), run_name="__main__")
