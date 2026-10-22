# SQLite 3.53.4(随包带)

从 better-sqlite3 13.0.3(engine-ts 的 package-lock 钉的那一版)的 `deps/sqlite3/` 原样拷来,它已经打上了 better-sqlite3 自己的
`deps/patches/1208.patch`(日期函数里 month / year 的秒数常量)。TS 引擎在装好的应用里用的就是这三份文件编出来的库,
编译开关见同目录 `CMakeLists.txt`(照 better-sqlite3 的 `deps/defines.gypi` + Release)。

| 文件 | sha256 |
|---|---|
| sqlite3.c | 6a2805f8c1ef020a7086e62258519323cf98b219e9fe87a42065d916cfebaefc |
| sqlite3.h | 919e7f2e8ed1d8f56ac17b412b8971c76aa5d1a879752cc6058f75e7d5910e1d |
| sqlite3ext.h | ac9645e5c9ff0cf176efdd6e75cb5e98f46295d38e02db5c4d208826a39ab4be |

`SQLITE_SOURCE_ID` = `2026-07-24 19:02:57 bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc`。不改这几份文件;升级就整份换,并更新上表。
