# Unity Licensing for Remote Workflows

Reviewed: 2026-10-07. This guide describes the toolkit's operating posture.
It is not legal advice or approval for a hosted offering.
The toolkit's MIT license does not grant rights to Unity software.
Your subscription, Editor version, and applicable Unity terms control the rights.

## Editor and Player Lanes

Every running Editor needs a valid entitlement on its host, including hidden
and batch-mode Editors. Hiding the window does not turn an Editor into a Player.
See Unity's [licensing overview](https://docs.unity.com/en-us/engine/6000.3/manual/get-started/install-and-upgrade/licenses-and-activation/license-overview).

| Lane | Runtime | Build step |
| --- | --- | --- |
| Local hidden Editor (L0) | Editor seat and valid local activation | Licensed Editor, activated through Hub or an approved automation flow |
| Warm Editor host (L1) | Editor entitlement for each active host/session | Licensed Editor or Build Server for eligible batch builds |
| Player Viewport Service (L2), including a Player shell (L3) | No Editor seat for the built Player process | Licensed Editor or Build Server for eligible batch builds |
| Remote virtual-display Editor | Editor entitlement for each active host/session | Licensed Editor or Build Server for eligible batch builds |

The [Viewport Service](../CursorUnityTool/Assets/ViewportService/ViewportServiceServer.cs)
uses runtime APIs without `UnityEditor` references. Its
[build script](../CursorUnityTool/Assets/Editor/ViewportServiceBuild.cs) runs in the Editor.
No Editor seat at Player runtime does not mean unrestricted hosting or distribution.
Unity permits Runtime distribution integrated into Projects, subject to its
[Software Terms, section 2.2](https://unity.com/legal/editor-terms-of-service/software).

[Unity Build Server](https://unity.com/blog/games/offload-project-builds-with-unity-build-server)
licenses cover batch builds. They do not replace interactive Editor seats for
Scene View, Inspector, or a warm editing session.

## Seats and Activation

Ordinary Editor seats cover individual users, not arbitrary shared hosts.
Non-floating seats allow one active Editor instance per seat.
See [Software Terms, section 2.8](https://unity.com/legal/editor-terms-of-service/software).

For one or two stable hosts, use your subscription's supported Hub, named-user,
or serial activation. Not every subscription provides serial keys.
Prefer a floating Unity Licensing Server for VM pools or more than two hosts.
This threshold is an operational recommendation, not a Unity licensing rule.
Floating licensing requires a purchased subscription and sufficient concurrent capacity.
See the [licensing overview](https://docs.unity.com/en-us/engine/6000.3/manual/get-started/install-and-upgrade/licenses-and-activation/license-overview)
and [Licensing Server guide](https://docs.unity.com/en-us/licensing-server).

Manual `.ulf` activation supports Enterprise or Industry assigned seats and
legacy serial-based Pro licenses. It does not support Pro assigned seats,
Personal, or floating subscriptions. Use the
[manual activation guide](https://docs.unity3d.com/6000.3/Documentation/Manual/ManualActivationGuide.html)
for the host's exact Editor version.

## BYOL and Third-Party Hosting

Bring your own license (BYOL) means each customer supplies their own entitlement.
It does not grant hosting rights or remove Unity's third-party restrictions.
Seek counsel and a separate Unity grant or agreement before offering hosted
Editors to external users. Have counsel confirm any Authorized User exception.
See [Software Terms, sections 2.1 and 2.8](https://unity.com/legal/editor-terms-of-service/software).

Seat activation also does not authorize agent or MCP access.
Unity's [Terms of Service, section 17.2](https://unity.com/legal/terms-of-service)
restrict that access to Authorized Agentic Access.
Confirm the applicable permission with Unity before using an automated offering.

## Guardrails

- Never bypass license checks through patching, spoofing, proxying, or hooking.
- Never extract or redistribute the Editor or native engine as standalone components.
- Never multiplex one seat across concurrent users or sessions beyond its entitlement.

These limits follow the [Software Terms](https://unity.com/legal/editor-terms-of-service/software)
and [Terms of Service, section 17.2](https://unity.com/legal/terms-of-service).
Supported Player distribution remains subject to the Project distribution terms above.

## License Helper

The [helper script](../unity-cursor-toolkit/scripts/unity-license.js) is available as
[`unity:license`](../unity-cursor-toolkit/package.json). Run these commands from the repo root:

```bash
npm --prefix unity-cursor-toolkit run unity:license -- status
npm --prefix unity-cursor-toolkit run unity:license -- activate
npm --prefix unity-cursor-toolkit run unity:license -- activate --named-user
npm --prefix unity-cursor-toolkit run unity:license -- activate --manual
npm --prefix unity-cursor-toolkit run unity:license -- activate --manual --ulf "$UNITY_LICENSE_FILE"
npm --prefix unity-cursor-toolkit run unity:license -- return
```

`activate` and `return` only print plans by default. The helper masks credentials
in those plans. Supply `UNITY_EMAIL`, `UNITY_PASSWORD`, and, for serial activation,
`UNITY_SERIAL` through the host environment or CI secret store.
For manual import, set `UNITY_LICENSE_FILE` to the operator-provided `.ulf` path.
Keep credentials and license files out of commits.

Review the dry-run plan first. Obtain explicit operator approval before adding
`--execute` to any activation, manual request/import, or return command.
Execution changes host licensing state and can start the installed Editor.
Use the [CLI licensing guide](https://docs.unity3d.com/6000.3/Documentation/Manual/ManagingYourUnityLicense.html)
to confirm the flow supports your subscription. Personal activation uses Unity Hub.

`status` reports paths, license-file presence, and environment-variable presence.
It does not prove that a seat is active. Verify entitlement in Unity Hub,
the Unity ID portal, or the Licensing Server administrator's records.
