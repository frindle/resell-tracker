#!/usr/bin/env python3
"""Build the "Send to Tracker" iOS Shortcut (unsigned plist).

Sign it on a Mac before sending it to the phone (iOS refuses unsigned files):
  python3 scripts/make-ios-shortcut.py /tmp/unsigned.shortcut
  shortcuts sign --mode anyone --input /tmp/unsigned.shortcut --output "Send to Tracker.shortcut"

No secrets go in the file: on import the phone asks for one setup code
(base64 of site|upload key|CF id|CF secret), built on Settings > Phone uploads.
"""
import plistlib
import sys
import uuid

OBJ = '￼'


def uid():
    return str(uuid.uuid4()).upper()


def var(name, *aggr):
    v = {'Type': 'Variable', 'VariableName': name}
    if aggr:
        v['Aggrandizements'] = list(aggr)
    return v


def out(action_uuid, name, *aggr):
    v = {'Type': 'ActionOutput', 'OutputName': name, 'OutputUUID': action_uuid}
    if aggr:
        v['Aggrandizements'] = list(aggr)
    return v


# "as Text": a pasted code (or the decoded file) can arrive as Rich Text,
# which Get Contents of URL refuses to turn into a URL.
AS_TEXT = {'Type': 'WFCoercionVariableAggrandizement', 'CoercionItemClass': 'WFStringContentItem'}



def attachment(v):
    return {'Value': v, 'WFSerializationType': 'WFTextTokenAttachment'}


def text(*parts):
    """Text with inline variables: parts are str or attachment dicts."""
    s, ranges = '', {}
    for p in parts:
        if isinstance(p, str):
            s += p
        else:
            # Inline tokens take the bare variable, not the attachment wrapper:
            # a wrapped one shows on the phone as "Unknown Variable".
            ranges[f'{{{len(s)}, 1}}'] = p.get('Value', p) if p.get('WFSerializationType') == 'WFTextTokenAttachment' else p
            s += OBJ
    if not ranges:
        return s
    return {'Value': {'string': s, 'attachmentsByRange': ranges}, 'WFSerializationType': 'WFTextTokenString'}


def field(key, value, item_type=0):
    return {'WFItemType': item_type, 'WFKey': text(key), 'WFValue': value}


def dict_value(items):
    return {'Value': {'WFDictionaryFieldValueItems': items}, 'WFSerializationType': 'WFDictionaryFieldValue'}


def action(ident, **params):
    return {'WFWorkflowActionIdentifier': ident, 'WFWorkflowActionParameters': params}


def build():
    u_url, u_key, u_cfid, u_cfsec = uid(), uid(), uid(), uid()
    u_conv, u_dl, u_val, u_comb = uid(), uid(), uid(), uid()
    grp = uid()

    # One setup code from Settings > Phone uploads: "<site>|<upload key>|<CF id>|<CF secret>".
    # The page base64-encodes it so it reads as one code, not a URL.
    u_code, u_dec, u_split = uid(), uid(), uid()
    actions = [
        action('is.workflow.actions.gettext', UUID=u_code, WFTextActionText='', CustomOutputName='Setup code'),
        action('is.workflow.actions.base64encode', UUID=u_dec, WFEncodeMode='Decode',
               WFInput=attachment(out(u_code, 'Setup code', AS_TEXT))),
        action('is.workflow.actions.text.split', UUID=u_split, WFTextSeparator='Custom', WFTextCustomSeparator='|',
               text=attachment(out(u_dec, 'Base64 Encoded', AS_TEXT))),
    ]
    for i, (u, name) in enumerate([(u_url, 'Site'), (u_key, 'Upload key'), (u_cfid, 'CF Client ID'), (u_cfsec, 'CF Client Secret')], 1):
        # Named variables, not the item outputs: on iOS the upload step inside the
        # Repeat showed the item outputs as "Unknown Variable" (Rich Text -> URL error).
        actions.append(action('is.workflow.actions.getitemfromlist', UUID=u, WFItemSpecifier='Item At Index', WFItemIndex=i,
                              WFInput=attachment(out(u_split, 'Split Text'))))
        actions.append(action('is.workflow.actions.setvariable', WFVariableName=name,
                              WFInput=attachment(out(u, 'Item from List', AS_TEXT))))
    # Build the upload URL once with a real URL action (a text field with an
    # empty or rich-text Site fails as "Rich Text to URL").
    u_link = uid()
    u_name, u_taken, u_taken_iso, u_created, u_created_iso = uid(), uid(), uid(), uid(), uid()

    def detail(u, name):
        return action('is.workflow.actions.properties.images', UUID=u, WFContentItemPropertyName=name,
                      WFInput=attachment(var('Repeat Item')))

    def iso(u, src):
        return action('is.workflow.actions.format.date', UUID=u, WFDateFormatStyle='ISO 8601',
                      WFISO8601IncludeTime=True, WFDate=text(attachment(out(src, 'Details of Images'))))

    detail_actions = [
        detail(u_name, 'Name'),
        detail(u_taken, 'Date Taken'), iso(u_taken_iso, u_taken),
        detail(u_created, 'Creation Date'), iso(u_created_iso, u_created),
    ]
    actions += [
        action('is.workflow.actions.url', UUID=u_link,
               WFURLActionURL=text(attachment(var('Site', AS_TEXT)), '/api/upload/photo')),
        action('is.workflow.actions.setvariable', WFVariableName='Upload URL',
               WFInput=attachment(out(u_link, 'URL'))),
    ]
    actions += [
        action('is.workflow.actions.repeat.each', UUID=uid(), GroupingIdentifier=grp, WFControlFlowMode=0,
               WFInput=attachment({'Type': 'ExtensionInput'})),
        action('is.workflow.actions.image.convert', UUID=u_conv, WFImageFormat='JPEG',
               WFImagePreserveMetadata=True, WFInput=attachment(var('Repeat Item'))),
        # Photo details via explicit Get Details / Format Date actions (documented
        # params in Cherri and the Minis action index) instead of inline
        # property/date aggrandizements, whose plist shape the references disagree on.
        *detail_actions,
        action(
            'is.workflow.actions.downloadurl', UUID=u_dl,
            WFURL=text(attachment(var('Upload URL'))),  # the URL field takes a text token, not a bare variable
            WFHTTPMethod='POST', ShowHeaders=True,
            WFHTTPHeaders=dict_value([
                field('Authorization', text('Bearer ', attachment(var('Upload key', AS_TEXT)))),
                field('CF-Access-Client-Id', text(attachment(var('CF Client ID', AS_TEXT)))),
                field('CF-Access-Client-Secret', text(attachment(var('CF Client Secret', AS_TEXT)))),
                # Name + photo date: survives iOS re-encoding, so a re-shared photo is skipped.
                field('X-Photo-Id', text(
                    attachment(out(u_name, 'Details of Images')), '-',
                    attachment(out(u_taken_iso, 'Formatted Date')), '-',
                    attachment(out(u_created_iso, 'Formatted Date')))),
                field('Content-Type', text('image/jpeg')),
                field('X-Captured-At', text(attachment(out(u_taken_iso, 'Formatted Date')))),
            ]),
            # Raw JPEG body: the Form file field arrived without the photo.
            WFHTTPBodyType='File',
            WFRequestVariable=attachment(out(u_conv, 'Converted Image')),
        ),
        action('is.workflow.actions.getvalueforkey', UUID=u_val, WFGetDictionaryValueType='Value',
               WFDictionaryKey='summary', WFInput=attachment(out(u_dl, 'Contents of URL'))),
        action('is.workflow.actions.appendvariable', WFVariableName='Results',
               WFInput=attachment(out(u_val, 'Dictionary Value'))),
        action('is.workflow.actions.repeat.each', GroupingIdentifier=grp, WFControlFlowMode=2, UUID=uid()),
        action('is.workflow.actions.text.combine', UUID=u_comb, WFTextSeparator='New Lines',
               text=attachment(var('Results'))),
        action('is.workflow.actions.notification', WFNotificationActionTitle='Send to Tracker',
               WFNotificationActionBody=text(attachment(out(u_comb, 'Combined Text')))),
    ]

    questions = [
        {'ActionIndex': 0, 'Category': 'Parameter', 'ParameterKey': 'WFTextActionText', 'DefaultValue': '',
         'Text': 'Paste the setup code from Settings > Phone uploads (tap Copy next to it)'},
    ]

    return {
        'WFWorkflowClientVersion': '2605.0.5',
        'WFWorkflowMinimumClientVersion': 900,
        'WFWorkflowMinimumClientVersionString': '900',
        'WFWorkflowIcon': {'WFWorkflowIconStartColor': 4282601983, 'WFWorkflowIconGlyphNumber': 59511},
        'WFWorkflowTypes': ['ActionExtension'],
        'WFWorkflowInputContentItemClasses': ['WFImageContentItem', 'WFPhotoMediaContentItem'],
        'WFWorkflowHasShortcutInputVariables': True,
        'WFWorkflowNoInputBehavior': {'Name': 'WFWorkflowNoInputBehaviorAskForInput',
                                      'Parameters': {'ItemClass': 'WFPhotoMediaContentItem'}},
        'WFWorkflowOutputContentItemClasses': [],
        'WFWorkflowImportQuestions': questions,
        'WFWorkflowActions': actions,
    }


if __name__ == '__main__':
    with open(sys.argv[1] if len(sys.argv) > 1 else 'unsigned.shortcut', 'wb') as f:
        plistlib.dump(build(), f, fmt=plistlib.FMT_BINARY)
