from desktop.executor import DesktopExecutor

executor = DesktopExecutor()

result = executor.execute(

    {

        "action":"open_app",

        "app":"chrome"

    }

)

print(result)