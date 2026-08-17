; 旧版还在运行时,覆盖安装会因文件被锁而失败——装前先礼后兵地结束它。
; taskkill 找不到进程时返回非零,无碍,继续即可。
!macro customInit
  nsExec::Exec 'taskkill /F /IM "Dafri Trading.exe" /T'
  Sleep 500
!macroend

!macro customUnInit
  nsExec::Exec 'taskkill /F /IM "Dafri Trading.exe" /T'
  Sleep 500
!macroend
