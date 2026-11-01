"""Builds the "Send to Alfred" iPhone shortcut as an unsigned plist.

Sign it on a Mac with:
  shortcuts sign --mode anyone --input send-to-alfred.unsigned.shortcut --output ../public/send-to-alfred.shortcut

The shortcut never asks for text: with no input it sends an empty ping
(so Alfred's Settings can show the automation fired without the message)
and stops. The forwarding key is asked for once, when it's imported.
"""

import plistlib
import sys
import uuid

ENDPOINT = "https://alfred.hansopoku.com/api/ingest/sms"
OBJ = "￼"


def uid() -> str:
    return str(uuid.uuid4()).upper()


def text(value: str) -> dict:
    return {"Value": {"string": value, "attachmentsByRange": {}}, "WFSerializationType": "WFTextTokenString"}


def output(action_uuid: str, name: str) -> dict:
    return {"OutputName": name, "OutputUUID": action_uuid, "Type": "ActionOutput"}


key_id, input_id, match_id, if_group, money_group = uid(), uid(), uid(), uid(), uid()
MONEY_PATTERN = r"\b(GHS|GHC|GH₵|GH¢|CEDIS)"


def post(body: dict | None) -> dict:
    headers = [
        {
            "WFItemType": 0,
            "WFKey": text("Authorization"),
            "WFValue": {
                "Value": {"string": f"Bearer {OBJ}", "attachmentsByRange": {"{7, 1}": output(key_id, "Text")}},
                "WFSerializationType": "WFTextTokenString",
            },
        },
        {"WFItemType": 0, "WFKey": text("Content-Type"), "WFValue": text("text/plain; charset=utf-8")},
    ]
    params = {
        "UUID": uid(),
        "WFURL": ENDPOINT,
        "WFHTTPMethod": "POST",
        "ShowHeaders": True,
        "WFHTTPHeaders": {"Value": {"WFDictionaryFieldValueItems": headers}, "WFSerializationType": "WFDictionaryFieldValue"},
        "WFHTTPBodyType": "File",
    }
    if body is not None:
        params["WFRequestVariable"] = {"Value": body, "WFSerializationType": "WFTextTokenAttachment"}
    return {"WFWorkflowActionIdentifier": "is.workflow.actions.downloadurl", "WFWorkflowActionParameters": params}


actions = [
    # 0: the forwarding key, filled in by the import question.
    {
        "WFWorkflowActionIdentifier": "is.workflow.actions.gettext",
        "WFWorkflowActionParameters": {"UUID": key_id, "WFTextActionText": text("alf_PASTE_YOUR_KEY")},
    },
    # 1: the message iOS passed in, as text.
    {
        "WFWorkflowActionIdentifier": "is.workflow.actions.gettext",
        "WFWorkflowActionParameters": {
            "UUID": input_id,
            "WFTextActionText": {
                "Value": {"string": OBJ, "attachmentsByRange": {"{0, 1}": {"Type": "ExtensionInput"}}},
                "WFSerializationType": "WFTextTokenString",
            },
        },
    },
    # 2: if it has any value…
    {
        "WFWorkflowActionIdentifier": "is.workflow.actions.conditional",
        "WFWorkflowActionParameters": {
            "UUID": uid(),
            "GroupingIdentifier": if_group,
            "WFControlFlowMode": 0,
            "WFCondition": 100,
            "WFInput": {"Type": "Variable", "Variable": {"Value": output(input_id, "Text"), "WFSerializationType": "WFTextTokenAttachment"}},
        },
    },
    # …and mentions money, send it. Other texts never leave the phone, so one automation can watch every message.
    {
        "WFWorkflowActionIdentifier": "is.workflow.actions.text.match",
        "WFWorkflowActionParameters": {
            "UUID": match_id,
            "WFMatchTextPattern": MONEY_PATTERN,
            "WFMatchTextCaseSensitive": False,
            "text": {
                "Value": {"string": OBJ, "attachmentsByRange": {"{0, 1}": output(input_id, "Text")}},
                "WFSerializationType": "WFTextTokenString",
            },
        },
    },
    {
        "WFWorkflowActionIdentifier": "is.workflow.actions.conditional",
        "WFWorkflowActionParameters": {
            "UUID": uid(),
            "GroupingIdentifier": money_group,
            "WFControlFlowMode": 0,
            "WFCondition": 100,
            "WFInput": {"Type": "Variable", "Variable": {"Value": output(match_id, "Matches"), "WFSerializationType": "WFTextTokenAttachment"}},
        },
    },
    post(output(input_id, "Text")),
    {
        "WFWorkflowActionIdentifier": "is.workflow.actions.conditional",
        "WFWorkflowActionParameters": {"UUID": uid(), "GroupingIdentifier": money_group, "WFControlFlowMode": 2},
    },
    {
        "WFWorkflowActionIdentifier": "is.workflow.actions.conditional",
        "WFWorkflowActionParameters": {"UUID": uid(), "GroupingIdentifier": if_group, "WFControlFlowMode": 1},
    },
    # …otherwise an empty ping, so Settings knows the automation ran without the message.
    post(None),
    {
        "WFWorkflowActionIdentifier": "is.workflow.actions.conditional",
        "WFWorkflowActionParameters": {"UUID": uid(), "GroupingIdentifier": if_group, "WFControlFlowMode": 2},
    },
]

shortcut = {
    "WFWorkflowActions": actions,
    "WFWorkflowClientVersion": "2700.0.4",
    "WFWorkflowMinimumClientVersion": 900,
    "WFWorkflowMinimumClientVersionString": "900",
    "WFWorkflowHasOutputFallback": False,
    "WFWorkflowHasShortcutInputVariables": True,
    # Run as an action with no input: carry on (the empty ping), never "Ask for text".
    "WFWorkflowNoInputBehavior": {"Name": "WFWorkflowNoInputBehaviorDoNothing", "Parameters": {}},
    "WFWorkflowIcon": {"WFWorkflowIconGlyphNumber": 59412, "WFWorkflowIconStartColor": 4292093695},
    "WFWorkflowImportQuestions": [
        {
            "ActionIndex": 0,
            "Category": "Parameter",
            "ParameterKey": "WFTextActionText",
            "Text": "Paste your Alfred forwarding key from Settings → Bank messages (it starts with alf_).",
            "DefaultValue": "",
        }
    ],
    "WFWorkflowInputContentItemClasses": ["WFStringContentItem", "WFRichTextContentItem", "WFGenericFileContentItem"],
    "WFWorkflowOutputContentItemClasses": [],
    "WFWorkflowTypes": ["ActionExtension"],
}

with open(sys.argv[1] if len(sys.argv) > 1 else "send-to-alfred.unsigned.shortcut", "wb") as handle:
    plistlib.dump(shortcut, handle, fmt=plistlib.FMT_XML)
