from browser.intelligence import WorldStateManager

manager = WorldStateManager()

manager.update(

    user_goal="Book Goa Trip",

    page_type="login",

    current_stage="login",

    next_stage="authenticate"

)

manager.observe(

    "buttons",

    12

)

manager.observe(

    "forms",

    1

)

manager.remember(

    "website",

    "makemytrip"

)

print(

    manager.get()

)