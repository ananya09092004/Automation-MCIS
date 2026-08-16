from desktop.executor import DesktopExecutor

executor = DesktopExecutor()

print(

    executor.execute(

        {

            "action": "create_folder",

            "path": "demo/MyProject"

        }

    )

)

print(

    executor.execute(

        {

            "action": "rename_folder",

            "source": "demo/MyProject",

            "new_name": "AI_Project"

        }

    )

)