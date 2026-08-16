from desktop.executor import DesktopExecutor

executor = DesktopExecutor()

result = executor.execute(

    {

        "action": "run_terminal",

        "command": "python --version"

    }

)

print(result)
print()
print(result.data.stdout)