from browser.controller import BrowserController
from browser.workflow import BrowserWorkflowExecutor

browser = BrowserController()

browser.start()

executor = BrowserWorkflowExecutor(browser)

workflow = [

    {

        "action": "goto",

        "url": "https://google.com"

    },

    {

        "action": "verify_title",

        "text": "Google"

    }

]

print(

    executor.run(workflow)

)

browser.stop()