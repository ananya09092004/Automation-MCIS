from desktop.automation.context import ContextManager

ctx = ContextManager()

ctx.set(

    "app",

    "chrome"

)

ctx.set(

    "website",

    "amazon.in"

)

ctx.set(

    "task",

    "shopping"

)

ctx.update(

    product="iPhone 17",

    quantity=1

)

print(

    ctx.get("app")

)

print(

    ctx.get("website")

)

print(

    ctx.exists("product")

)

print(

    ctx.all()

)

ctx.remove(

    "website"

)

print(

    ctx.all()

)