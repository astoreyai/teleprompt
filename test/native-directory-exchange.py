"""Exchange actual directory entries during a bounded Linux filesystem race test."""
import ctypes
import os
import sys
import time

libc = ctypes.CDLL(None, use_errno=True)
exchange = libc.renameat2
exchange.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
exchange.restype = ctypes.c_int
left, right = (os.fsencode(path) for path in sys.argv[1:3])
count = 0
print('ready', flush=True)
end = time.monotonic() + 1
while time.monotonic() < end:
    if exchange(-100, left, -100, right, 2) != 0:
        raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()))
    count += 1
print(count, flush=True)
