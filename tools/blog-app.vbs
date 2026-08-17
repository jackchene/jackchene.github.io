' 博客客户端静默启动入口:双击/快捷方式调用,不闪黑窗
CreateObject("WScript.Shell").Run "cmd /c node """ & Replace(WScript.ScriptFullName, "blog-app.vbs", "blog-app.mjs") & """", 0, False
