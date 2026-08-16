from desktop.process_manager import ProcessManager

pm = ProcessManager()

print(pm.exists("chrome"))

print(pm.pid("chrome"))

processes = pm.list_processes()

print(f"Running Processes: {len(processes)}")

print(processes[:10])