from desktop.automation.state import DesktopStateManager

state = DesktopStateManager()

print(

    state.is_app_open(

        "Chrome"

    )

)

print(

    state.ensure_window(

        "Chrome"

    )

)