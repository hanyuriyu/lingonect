# Unban request to Baidu — ready to send

Only needed if `check-baidu-ip.sh` says the relay's address is banned (58003)
and it has not aged out on its own after a day or two. See the README: a
dedicated address carrying one App ID normally clears itself, and reassigning
the address is faster than waiting on this queue.

**To:** translate_api@baidu.com

Fill in every `⟨…⟩`. Baidu's FAQ warns that incomplete information hurts the
review, so send all six fields even if some feel redundant. Send the Chinese
version — it is their working language and gets read faster. The English text
below it is the same message, safe to leave in as a courtesy.

---

**主题：** 申请解除服务器 IP 封禁（error_code 58003）— APPID ⟨你的APPID⟩

您好，

我们在调用百度翻译开放平台通用翻译 API 时持续收到 error_code 58003（此IP已被封禁）。

我们确认为正常合规使用：服务器使用独享固定 IP，该 IP 仅用于我方唯一 APPID 的翻译请求，未与其他 APPID 共用；我们也从未将 APPID 及密钥泄露或填写至任何第三方软件。账户状态正常，余额充足。

恳请核实并解除该 IP 的封禁，谢谢！

- 公司名称：⟨公司名称⟩
- 产品名称：Lingonect（https://www.lingonect.com）
- 联系人：⟨姓名⟩
- 联系方式：⟨邮箱／电话⟩
- 服务器 IP：⟨check-baidu-ip.sh 验证过的出口 IP⟩
- APPID：⟨你的APPID⟩

顺颂商祺

---

**Subject:** Request to lift server IP ban (error_code 58003) — APPID ⟨your APPID⟩

Hello,

We are consistently receiving `error_code 58003` (此IP已被封禁) when calling the
general translation API on the Baidu Translate Open Platform.

Our usage is legitimate: the server uses a dedicated static IP, that IP is used
only for translation requests under our single APPID and is not shared with any
other APPID, and we have never disclosed our APPID or secret key or entered them
into any third-party software. The account is in good standing with sufficient
credit.

We would be grateful if you could verify this and lift the ban on the address.

- Company name: ⟨company⟩
- Product name: Lingonect (https://www.lingonect.com)
- Contact person: ⟨name⟩
- Contact details: ⟨email / phone⟩
- Server IP: ⟨the egress IP verified with check-baidu-ip.sh⟩
- APPID: ⟨your APPID⟩

Thank you.
