"""Office add-in manifests (XML) for Word, Excel, PowerPoint and Outlook.

All four point at one public route, /office-addin?app=..., which loads Office.js and
routes to the right tool inside the app (see web/src/office). The base URL and a stable
add-in id per instance are filled in when the manifest is downloaded, so the same code
serves every customer's own domain.
"""

import uuid
from xml.sax.saxutils import escape, quoteattr

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from app import config, db, settings_store

router = APIRouter(prefix="/api/office", tags=["office"])

DOCUMENT_APPS = {
    # app: (manifest host name, VersionOverrides host type, display name)
    "word": ("Document", "Document", "Word"),
    "excel": ("Workbook", "Workbook", "Excel"),
    "powerpoint": ("Presentation", "Presentation", "PowerPoint"),
}
APPS = [*DOCUMENT_APPS, "outlook"]


def _addin_id(app: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"{config.settings.origin}/office-addin/{app}"))


def _icons(base: str) -> str:
    return "".join(f'<bt:Image id="Icon.{s}" DefaultValue={quoteattr(f"{base}/office/icon-{s}.png")}/>'
                   for s in (16, 32, 80))


def _icon_ref() -> str:
    return '<Icon><bt:Image size="16" resid="Icon.16"/><bt:Image size="32" resid="Icon.32"/><bt:Image size="80" resid="Icon.80"/></Icon>'


def _button(control_id: str, url_id: str) -> str:
    return f"""<Control xsi:type="Button" id="{control_id}">
              <Label resid="Button.Label"/>
              <Supertip><Title resid="Button.Label"/><Description resid="Button.Tooltip"/></Supertip>
              {_icon_ref()}
              <Action xsi:type="ShowTaskpane"><TaskpaneId>GaerPane</TaskpaneId><SourceLocation resid="{url_id}"/></Action>
            </Control>"""


def _strings(name: str) -> str:
    return f"""<bt:ShortStrings>
        <bt:String id="Group.Label" DefaultValue={quoteattr(name)}/>
        <bt:String id="Button.Label" DefaultValue={quoteattr(f"Åbn {name}")}/>
      </bt:ShortStrings>
      <bt:LongStrings>
        <bt:String id="Button.Tooltip" DefaultValue={quoteattr(f"Åbn {name} i en sidebar")}/>
      </bt:LongStrings>"""


def _header(app: str, name: str, base: str, kind: str, extra_ns: str = "") -> str:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<OfficeApp xmlns="http://schemas.microsoft.com/office/appforoffice/1.1"
           xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
           xmlns:bt="http://schemas.microsoft.com/office/officeappbasictypes/1.0"{extra_ns}
           xsi:type="{kind}">
  <Id>{_addin_id(app)}</Id>
  <Version>1.0.0.0</Version>
  <ProviderName>Happy Mates</ProviderName>
  <DefaultLocale>da-DK</DefaultLocale>
  <DisplayName DefaultValue={quoteattr(name)}/>
  <Description DefaultValue={quoteattr(f"{name}: indsæt og gem tekstklip fra {name}.")}/>
  <IconUrl DefaultValue={quoteattr(f"{base}/office/icon-32.png")}/>
  <HighResolutionIconUrl DefaultValue={quoteattr(f"{base}/office/icon-80.png")}/>
  <SupportUrl DefaultValue={quoteattr(f"{base}/w/")}/>
  <AppDomains><AppDomain>{escape(base)}</AppDomain></AppDomains>"""


def document_manifest(app: str, name: str, base: str) -> str:
    host, ov_host, _ = DOCUMENT_APPS[app]
    url = f"{base}/office-addin?app={app}"
    return _header(app, name, base, "TaskPaneApp", '\n           xmlns:ov="http://schemas.microsoft.com/office/taskpaneappversionoverrides"') + f"""
  <Hosts><Host Name="{host}"/></Hosts>
  <DefaultSettings><SourceLocation DefaultValue={quoteattr(url)}/></DefaultSettings>
  <Permissions>ReadWriteDocument</Permissions>
  <VersionOverrides xmlns="http://schemas.microsoft.com/office/taskpaneappversionoverrides" xsi:type="VersionOverridesV1_0">
    <Hosts>
      <Host xsi:type="{ov_host}">
        <DesktopFormFactor>
          <ExtensionPoint xsi:type="PrimaryCommandSurface">
            <OfficeTab id="TabHome">
              <Group id="Gaer.Group">
                <Label resid="Group.Label"/>
                {_icon_ref()}
                {_button("Gaer.Open", "Taskpane.Url")}
              </Group>
            </OfficeTab>
          </ExtensionPoint>
        </DesktopFormFactor>
      </Host>
    </Hosts>
    <Resources>
      <bt:Images>{_icons(base)}</bt:Images>
      <bt:Urls><bt:Url id="Taskpane.Url" DefaultValue={quoteattr(url)}/></bt:Urls>
      {_strings(name)}
    </Resources>
  </VersionOverrides>
</OfficeApp>
"""


def outlook_manifest(name: str, base: str) -> str:
    read_url = f"{base}/office-addin?app=outlook&mode=read"
    compose_url = f"{base}/office-addin?app=outlook&mode=compose"
    return _header("outlook", name, base, "MailApp") + f"""
  <Hosts><Host Name="Mailbox"/></Hosts>
  <Requirements><Sets><Set Name="Mailbox" MinVersion="1.5"/></Sets></Requirements>
  <FormSettings>
    <Form xsi:type="ItemRead">
      <DesktopSettings><SourceLocation DefaultValue={quoteattr(read_url)}/><RequestedHeight>300</RequestedHeight></DesktopSettings>
    </Form>
    <Form xsi:type="ItemEdit">
      <DesktopSettings><SourceLocation DefaultValue={quoteattr(compose_url)}/></DesktopSettings>
    </Form>
  </FormSettings>
  <Permissions>ReadWriteMailbox</Permissions>
  <Rule xsi:type="RuleCollection" Mode="Or">
    <Rule xsi:type="ItemIs" ItemType="Message" FormType="Read"/>
    <Rule xsi:type="ItemIs" ItemType="Message" FormType="Edit"/>
  </Rule>
  <VersionOverrides xmlns="http://schemas.microsoft.com/office/mailappversionoverrides" xsi:type="VersionOverridesV1_0">
    <Requirements><bt:Sets DefaultMinVersion="1.5"><bt:Set Name="Mailbox"/></bt:Sets></Requirements>
    <Hosts>
      <Host xsi:type="MailHost">
        <DesktopFormFactor>
          <ExtensionPoint xsi:type="MessageReadCommandSurface">
            <OfficeTab id="TabDefault">
              <Group id="Gaer.ReadGroup">
                <Label resid="Group.Label"/>
                {_button("Gaer.OpenRead", "Read.Url")}
              </Group>
            </OfficeTab>
          </ExtensionPoint>
          <ExtensionPoint xsi:type="MessageComposeCommandSurface">
            <OfficeTab id="TabDefault">
              <Group id="Gaer.ComposeGroup">
                <Label resid="Group.Label"/>
                {_button("Gaer.OpenCompose", "Compose.Url")}
              </Group>
            </OfficeTab>
          </ExtensionPoint>
        </DesktopFormFactor>
      </Host>
    </Hosts>
    <Resources>
      <bt:Images>{_icons(base)}</bt:Images>
      <bt:Urls>
        <bt:Url id="Read.Url" DefaultValue={quoteattr(read_url)}/>
        <bt:Url id="Compose.Url" DefaultValue={quoteattr(compose_url)}/>
      </bt:Urls>
      {_strings(name)}
    </Resources>
  </VersionOverrides>
</OfficeApp>
"""


async def _name() -> str:
    async with db.connection() as conn:
        return await settings_store.get(conn, "app_name")


@router.get("/manifests")
async def list_manifests():
    base = config.settings.origin.rstrip("/")
    return [{"app": app, "url": f"/api/office/manifests/{app}.xml", "taskpane": f"{base}/office-addin?app={app}"}
            for app in APPS]


@router.get("/manifests/{app}.xml")
async def manifest(app: str):
    if app not in APPS:
        raise HTTPException(404)
    base = config.settings.origin.rstrip("/")
    name = await _name()
    xml = outlook_manifest(name, base) if app == "outlook" else document_manifest(app, name, base)
    return Response(xml, media_type="application/xml", headers={
        "Content-Disposition": f'attachment; filename="{app}-manifest.xml"'})
