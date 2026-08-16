from browser.engines import BrowserEngine

from browser.execution import WorkflowEngine

engine = BrowserEngine()

engine.start()

page = engine.new_page()

workflow = WorkflowEngine(page)

result = workflow.execute(

    [

        {

            "action":"goto",

            "url":"https://google.com"

        },

        {

            "action":"search",

            "query":"OpenAI"

        }

    ]

)

print(result)

engine.stop()