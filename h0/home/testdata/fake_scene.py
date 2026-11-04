"""Home --fake stand-in for make.play / place.serve: prints the page URL it was given, then waits to be killed."""
import sys
import time

print(sys.argv[1], flush=True)
while True:
    time.sleep(3600)
