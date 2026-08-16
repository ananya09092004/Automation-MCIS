from desktop.window_manager.manager import WindowManager

wm = WindowManager()

print("Active Window:")
print(wm.active_window())

print()

print("All Windows:")
print(wm.list_windows())

print()

print("Find Chrome:")
print(wm.find("chrome"))