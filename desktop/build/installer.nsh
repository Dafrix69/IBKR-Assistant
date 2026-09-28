; 旧版还在运行时,覆盖安装会因文件被锁而失败——装前先礼后兵地结束它。
; 先礼:不带 /F 的 taskkill 是请它自己退出(发 WM_CLOSE)。应用收到后会等交易引擎把在途请求答完、
;       正在发的那张单落完库再退(main.js 的 before-quit)。给它 6 秒。
; 后兵:6 秒后还在,再强制结束。
; 两个名字都要认:2026-09-17 产品从 Dafri Trading 改名 IBKR-Assistant,老版本的进程名是旧的。
; taskkill 找不到进程时返回非零,无碍,继续即可。
!macro dafriCloseRunning
  nsExec::Exec 'taskkill /IM "IBKR-Assistant.exe" /T'
  nsExec::Exec 'taskkill /IM "Dafri Trading.exe" /T'
  Sleep 6000
  nsExec::Exec 'taskkill /F /IM "IBKR-Assistant.exe" /T'
  nsExec::Exec 'taskkill /F /IM "Dafri Trading.exe" /T'
  Sleep 500
!macroend

!macro customInit
  !insertmacro dafriCloseRunning
!macroend

!macro customUnInit
  !insertmacro dafriCloseRunning
!macroend
