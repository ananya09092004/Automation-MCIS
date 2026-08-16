from desktop.executor import DesktopExecutor

executor = DesktopExecutor()

print(

    executor.execute(

        {

            "action":"create_file",

            "path":"demo/test.txt"

        }

    )

)