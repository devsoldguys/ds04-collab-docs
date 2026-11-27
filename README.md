# DS04: Hệ thống soạn thảo tài liệu cộng tác (mô phỏng Google Docs)

Môn học: Hệ phân tán. Đề tài: DS04. Nhóm 13.

| Mã sinh viên | Họ và tên | Phần phụ trách |
|---|---|---|
| B23DCVT315 | Nguyễn Tất Khôi Nguyên | Máy chủ, lưu trữ, bảo mật, triển khai, đo hiệu năng |
| B23DCVT341 | Nguyễn Duy Phúc | CRDT, máy khách đồng bộ, giao diện web, CLI |

Bảng phân công chi tiết nằm ở [mục 16](#16-phân-công-công-việc).

> GHI CHÚ: README này viết theo quy tắc ASD-STE100 (tiếng Anh kỹ thuật giản lược), áp dụng cho tiếng Việt. Mỗi câu có một ý. Mỗi bước có một hành động. Mỗi khái niệm dùng một thuật ngữ cố định (xem mục 2).

## Mục lục

1. [Giới thiệu](#1-giới-thiệu)
2. [Thuật ngữ](#2-thuật-ngữ)
3. [Kiến trúc](#3-kiến-trúc)
4. [Định danh](#4-định-danh)
5. [Giao thức và định dạng thông điệp](#5-giao-thức-và-định-dạng-thông-điệp)
6. [Đồng thời và nhất quán](#6-đồng-thời-và-nhất-quán)
7. [Chịu lỗi và phục hồi](#7-chịu-lỗi-và-phục-hồi)
8. [Bảo mật](#8-bảo-mật)
9. [Yêu cầu môi trường](#9-yêu-cầu-môi-trường)
10. [Cài đặt](#10-cài-đặt)
11. [Chạy hệ thống](#11-chạy-hệ-thống)
12. [Kịch bản demo](#12-kịch-bản-demo)
13. [Kiểm thử](#13-kiểm-thử)
14. [Đánh giá hiệu năng](#14-đánh-giá-hiệu-năng)
15. [Triển khai lại bằng Docker](#15-triển-khai-lại-bằng-docker)
16. [Phân công công việc](#16-phân-công-công-việc)
17. [Cấu trúc thư mục](#17-cấu-trúc-thư-mục)
18. [Giới hạn](#18-giới-hạn)
19. [Tài liệu tham khảo](#19-tài-liệu-tham-khảo)

## 1. Giới thiệu

Hệ thống cho phép nhiều người sửa cùng một tài liệu văn bản gần như theo thời gian thực.
Mỗi người dùng mở tài liệu trên trình duyệt hoặc trên dòng lệnh (CLI).
Máy chủ nhận thao tác của một máy khách và gửi thao tác đó đến các máy khách khác.
Sau các thao tác đồng thời, mọi máy khách có cùng nội dung.

Hệ thống không dùng "last writer wins".
Hệ thống dùng CRDT kiểu RGA (Replicated Growable Array). Nhóm tự viết CRDT này trong `src/shared/crdt.ts`.

Công nghệ:

| Thành phần | Công nghệ |
|---|---|
| Ngôn ngữ | TypeScript |
| Runtime, máy chủ HTTP + WebSocket, bundler, test runner | Bun 1.3 |
| Lưu trữ | SQLite (`bun:sqlite`, chế độ WAL) |
| Băm mật khẩu | argon2id (`Bun.password`) |
| Giao diện | HTML + TypeScript, không dùng framework |
| Triển khai | Docker, Docker Compose, Caddy (HTTPS/WSS, tùy chọn) |

Dự án không có thư viện chạy (runtime dependency) nào. Hai gói `typescript` và `@types/bun` chỉ dùng để kiểm tra kiểu.

## 2. Thuật ngữ

README dùng các thuật ngữ sau với một nghĩa duy nhất.

| Thuật ngữ | Nghĩa |
|---|---|
| Máy chủ | Tiến trình `bun src/server/main.ts`. Một máy chủ phục vụ nhiều tài liệu. |
| Máy khách | Một tab trình duyệt hoặc một tiến trình CLI đã mở một tài liệu. |
| Client ID | Mã duy nhất của một máy khách, dạng `<tên người dùng>-<8 ký tự ngẫu nhiên>`. Ví dụ: `bob-j6kdun76`. |
| Thao tác | Một lệnh chèn một ký tự hoặc xóa một ký tự. Mỗi thao tác có một ID duy nhất. |
| Bản sao | Bản CRDT của tài liệu trong bộ nhớ. Mỗi máy khách có một bản sao. Máy chủ có một bản sao cho mỗi tài liệu đang mở. |
| Room | Đối tượng trên máy chủ cho một tài liệu đang mở. Room giữ bản sao của máy chủ và danh sách máy khách đang kết nối. |
| State vector | Bảng `Client ID -> seq lớn nhất đã nhận`. State vector cho biết một bản sao đã có những thao tác nào. |
| Outbox | Hàng đợi trên máy khách. Outbox giữ các thao tác cục bộ mà máy chủ chưa xác nhận. |
| Ack | Thông điệp máy chủ gửi khi máy chủ đã ghi một lô thao tác vào SQLite. |
| Tombstone | Ký tự đã xóa. CRDT giữ ký tự này trong danh sách và đánh dấu "đã xóa". |

## 3. Kiến trúc

```
   Máy khách 1..N (trình duyệt hoặc CLI)                     Máy chủ cộng tác (1 tiến trình Bun)
 ┌─────────────────────────────────────┐   HTTP REST    ┌──────────────────────────────────────────┐
 │ Giao diện: web/app.ts hoặc cli.ts   │ ─────────────▶ │ API: đăng ký, đăng nhập, tài liệu, chia sẻ│
 │                                     │                │                                          │
 │ SyncClient (sync-client.ts)         │   WebSocket    │ WebSocket: join, ops, cursor, ping       │
 │  outbox, ack, retry, heartbeat,     │ ◀────────────▶ │ Heartbeat: phát hiện máy khách im lặng   │
 │  reconnect, gửi lại thao tác        │   JSON         │                                          │
 │                                     │                │ Room (1 tài liệu = 1 room)               │
 │ TextDoc (crdt.ts): bản sao CRDT     │                │  TextDoc: bản sao CRDT của máy chủ       │
 └─────────────────────────────────────┘                │                                          │
                                                        │ Store (store.ts): SQLite                 │
                                                        │  users, docs, members, ops (nhật ký)     │
                                                        └──────────────────────────────────────────┘
```

Trách nhiệm của từng thành phần:

| Thành phần | Tệp | Trách nhiệm |
|---|---|---|
| CRDT | `src/shared/crdt.ts` | Lưu ký tự và tombstone. Chuyển vị trí thành thao tác. Tích hợp thao tác từ xa. Bỏ thao tác trùng. Giữ thao tác đến sai thứ tự trong bộ đệm. |
| Giao thức | `src/shared/protocol.ts` | Định nghĩa thông điệp. Kiểm tra mọi thông điệp từ máy khách. |
| Nhật ký | `src/shared/log.ts` | Ghi một dòng cho mỗi sự kiện: thời gian, nút, loại sự kiện, kết quả. |
| SyncClient | `src/client/sync-client.ts` | Giữ kết nối. Gửi outbox. Chờ ack. Gửi lại. Kết nối lại. Gửi heartbeat. |
| Giao diện web | `src/client/web/` | Đăng nhập, danh sách tài liệu, trình soạn thảo, con trỏ người khác, người đang mở, nhật ký sự kiện. |
| CLI | `src/client/cli.ts` | Máy khách dòng lệnh. Dùng cho demo nhiều tiến trình và cho script. |
| Máy chủ | `src/server/main.ts` | API HTTP, WebSocket, kiểm tra quyền, phát thao tác, heartbeat. |
| Room | `src/server/room.ts` | Giữ bản sao của máy chủ. Ghi thao tác mới vào SQLite trước khi gửi ack. |
| Store | `src/server/store.ts` | Bảng `users`, `docs`, `members`, `ops`. |
| Xác thực | `src/server/auth.ts` | Băm mật khẩu argon2id. Ký và kiểm tra token HMAC-SHA256. |

Hệ thống có ít nhất 4 tiến trình độc lập trong demo: 1 máy chủ và 3 máy khách. Các tiến trình chỉ trao đổi dữ liệu qua mạng (HTTP và WebSocket). Các tiến trình không dùng bộ nhớ chung hoặc tệp chung.

Luồng một thao tác chèn:

1. Người dùng gõ một ký tự trong trình soạn thảo.
2. Giao diện so sánh văn bản cũ và mới, rồi gọi `client.insert(vị trí, ký tự)`.
3. `TextDoc` tạo thao tác, áp dụng thao tác ngay trên bản sao cục bộ, rồi trả thao tác.
4. `SyncClient` đưa thao tác vào outbox và gửi một lô `ops` đến máy chủ.
5. Máy chủ kiểm tra lô, tích hợp lô vào bản sao của máy chủ, rồi ghi thao tác mới vào SQLite trong một transaction.
6. Máy chủ gửi `ack` cho máy khách gửi, và gửi `ops` cho các máy khách khác trong room.
7. Khi nhận `ack`, máy khách đã gửi lô xóa lô đó khỏi outbox.
8. Các máy khách khác tích hợp thao tác và vẽ lại văn bản. Con trỏ của các máy khách này không nhảy.

## 4. Định danh

| Đối tượng | Định danh | Ai tạo | Quy tắc |
|---|---|---|---|
| Người dùng | Tên người dùng | Người dùng khi đăng ký | `[a-z0-9_]{3,32}`, duy nhất trong bảng `users` |
| Máy khách | Client ID | Máy khách khi khởi động | `<tên người dùng>-<ngẫu nhiên>`. Máy chủ từ chối Client ID không bắt đầu bằng tên người dùng của token. |
| Tài liệu | Mã tài liệu | Máy chủ khi tạo tài liệu | 10 ký tự `[a-z0-9]` ngẫu nhiên |
| Thao tác | ID thao tác | Máy khách tạo thao tác | `<Client ID>:<seq>`. `seq` tăng 1, 2, 3... cho mỗi máy khách. |
| Máy chủ | Server ID | Biến môi trường `SERVER_ID` | Ví dụ `server-1`. Máy chủ ghi Server ID vào mọi dòng nhật ký. |

Khám phá dịch vụ: máy khách biết địa chỉ máy chủ qua URL (trình duyệt) hoặc qua tham số `--server` (CLI). Máy khách biết các máy khách khác qua thông điệp `presence` của máy chủ.

## 5. Giao thức và định dạng thông điệp

### 5.1. API HTTP

Mọi yêu cầu, trừ đăng ký và đăng nhập, cần header `Authorization: Bearer <token>`.

| Phương thức | Đường dẫn | Chức năng |
|---|---|---|
| POST | `/api/register` | Tạo tài khoản. Trả token. |
| POST | `/api/login` | Đăng nhập. Trả token. |
| GET | `/api/docs` | Liệt kê tài liệu người dùng có quyền. |
| POST | `/api/docs` | Tạo tài liệu. Người tạo là chủ sở hữu. |
| GET | `/api/docs/:id` | Đọc tiêu đề, chủ sở hữu, quyền, thành viên. |
| POST | `/api/docs/:id/members` | Chia sẻ tài liệu (chỉ chủ sở hữu). Quyền: `editor` hoặc `viewer`. |
| GET | `/api/docs/:id/export` | Tải nội dung tài liệu dạng `.txt`. |
| GET | `/api/health` | Trạng thái máy chủ: thời gian chạy, bộ nhớ, CPU, các room. |
| GET | `/ws?token=...` | Mở kết nối WebSocket. |

### 5.2. Thông điệp WebSocket (JSON)

| Hướng | `type` | Nội dung chính | Mục đích |
|---|---|---|---|
| Khách -> chủ | `join` | `doc`, `replica` (Client ID), `sv` (state vector) | Mở tài liệu hoặc đồng bộ lại sau khi mất kết nối |
| Chủ -> khách | `joined` | `role`, `title`, `version`, `ops` (thao tác máy khách còn thiếu), `users` | Trả trạng thái ban đầu |
| Khách -> chủ | `ops` | `batch` (mã lô), `ops` (tối đa 1000 thao tác) | Gửi thao tác cục bộ |
| Chủ -> khách | `ack` | `batch`, `applied`, `duplicates`, `buffered`, `version` | Xác nhận lô đã ghi vào SQLite |
| Chủ -> khách | `ops` | `from`, `ops`, `version` | Phát thao tác của máy khách khác |
| Chủ -> khách | `presence` | `users`, `reason` | Danh sách người đang mở thay đổi |
| Hai chiều | `cursor` | `anchor` | Vị trí con trỏ (theo ID ký tự, không theo số thứ tự) |
| Khách -> chủ | `ping` | `t` | Heartbeat |
| Chủ -> khách | `pong` | `t`, `server` | Trả lời heartbeat |
| Chủ -> khách | `error` | `code`, `message`, `batch` | Từ chối thông điệp. Mã lỗi: `BAD_MESSAGE`, `TOO_LARGE`, `NOT_JOINED`, `FORBIDDEN`, `NOT_FOUND`, `BAD_REPLICA`, `DOC_TOO_LARGE`, `TOO_MANY_PENDING` |

### 5.3. Cấu trúc một thao tác

Mỗi thao tác có ID, Client ID, mã tài liệu, loại thao tác và thông tin phiên bản (`seq`, `clock`).

```json
{ "id": "bob-j6kdun76:12", "kind": "insert", "doc": "3zig0bnysi", "client": "bob-j6kdun76",
  "seq": 12, "clock": 57, "after": "alice-qmwxrk5x:31", "char": "x" }

{ "id": "bob-j6kdun76:13", "kind": "delete", "doc": "3zig0bnysi", "client": "bob-j6kdun76",
  "seq": 13, "clock": 58, "target": "alice-qmwxrk5x:30" }
```

| Trường | Nghĩa |
|---|---|
| `seq` | Số thứ tự của thao tác trong máy khách. Dùng để phát hiện thao tác trùng và thao tác đến sai thứ tự. |
| `clock` | Đồng hồ logic Lamport. Dùng để sắp xếp các lệnh chèn đồng thời. |
| `after` | ID của ký tự bên trái tại lúc chèn. `null` nghĩa là đầu tài liệu. |
| `target` | ID của ký tự cần xóa. |

### 5.4. Nhật ký

Máy chủ và CLI ghi mỗi sự kiện trên một dòng:

```
2026-11-27T16:22:21.263Z [server-1] OPS conn=qs0rg3 replica=alice-cp8wjjuu doc=3zig0bnysi batch=cp8wjjuu-2 received=4 applied=4 duplicates=0 buffered=0 version=15 ms=0.91 result=OK
2026-11-27T16:22:21.271Z [bob-1gzuxwhp] ACK batch=1gzuxwhp-1 applied=3 duplicates=0 version=18 result=OK
```

Thứ tự trường: thời gian ISO, `[nút]`, loại sự kiện, các cặp `khóa=giá trị`, `result=`.
Các loại sự kiện chính: `SERVER_START`, `REGISTER`, `LOGIN`, `DOC_CREATE`, `SHARE`, `WS_OPEN`, `WS_REJECT`, `JOIN`, `ROOM_LOAD`, `OPS`, `LEAVE`, `HEARTBEAT_TIMEOUT`, `WS_ERROR`, `WS_CLOSE`. Máy khách ghi thêm `SEND`, `ACK`, `ACK_TIMEOUT`, `REMOTE_OPS`, `RECONNECT_WAIT`, `JOINED`, `HEARTBEAT_LOST`, `DELIVERY_ERROR`.

Giao diện web hiện nhật ký của máy khách trong ô "Nhật ký sự kiện".

## 6. Đồng thời và nhất quán

### 6.1. Mô hình nhất quán

Hệ thống dùng nhất quán cuối cùng mạnh (strong eventual consistency).
Hai bản sao đã nhận cùng một tập thao tác có cùng nội dung. Thứ tự nhận không ảnh hưởng đến kết quả.
Mỗi máy khách thấy thao tác của chính nó ngay lập tức. Máy khách không chờ máy chủ.

Hệ thống bảo đảm thêm hai điều kiện:

- Mỗi bản sao tích hợp thao tác của một máy khách theo đúng thứ tự `seq`.
- Mỗi bản sao chỉ tích hợp một thao tác khi đã có thao tác mà nó tham chiếu (`after` hoặc `target`). Đây là thứ tự nhân quả.

### 6.2. Cơ chế: CRDT RGA

1. Mỗi ký tự là một phần tử có ID duy nhất `<Client ID>:<seq>`.
2. Lệnh chèn nói "đặt ký tự này ngay sau phần tử `after`". Lệnh chèn không dùng số vị trí.
3. Hai lệnh chèn đồng thời sau cùng một phần tử: phần tử có `(clock, Client ID)` lớn hơn đứng trước.
4. Lệnh xóa đánh dấu phần tử là tombstone. Lệnh xóa không bỏ phần tử khỏi danh sách.
5. Tất cả bản sao chạy cùng quy tắc. Vì vậy tất cả bản sao có cùng thứ tự phần tử.

Máy chủ không biến đổi (transform) thao tác như OT. Máy chủ chỉ tích hợp, lưu và chuyển tiếp thao tác. Vì vậy máy khách có thể sửa khi mất kết nối và gửi thao tác sau.

### 6.3. Các xung đột và cách xử lý

| Xung đột | Kết quả |
|---|---|
| Hai người chèn tại cùng một vị trí | Cả hai đoạn chèn còn lại. Mỗi đoạn giữ liền nhau. Thứ tự theo `(clock, Client ID)`, giống nhau trên mọi máy. |
| Một người chèn trong khoảng mà người khác xóa | Ký tự mới còn lại. Lệnh xóa chỉ xóa các ký tự đã có khi người xóa thực hiện lệnh. |
| Hai người xóa cùng một ký tự | Ký tự bị xóa một lần. Lệnh xóa thứ hai không thay đổi gì. |
| Thao tác đến hai lần | Bản sao bỏ thao tác có `seq` nhỏ hơn hoặc bằng state vector. |
| Thao tác đến sai thứ tự | Bản sao giữ thao tác trong bộ đệm `pending` đến khi thao tác phụ thuộc đến. |
| Con trỏ khi người khác sửa | Con trỏ gắn với ID ký tự bên trái, không gắn với số vị trí. Con trỏ không nhảy. |

Kiểm thử chứng minh hội tụ: `[U10]` chạy 300 lần ngẫu nhiên với 3 bản sao. Mỗi lần có thao tác bị xáo trộn thứ tự và bị gửi lặp. Mọi lần đều hội tụ.

## 7. Chịu lỗi và phục hồi

### 7.1. Mô hình lỗi

| Lỗi được xử lý | Lỗi không được xử lý |
|---|---|
| Máy khách mất kết nối, đóng tab, dừng đột ngột | Máy chủ hỏng đĩa (mất tệp SQLite) |
| Máy chủ dừng đột ngột (SIGKILL) rồi khởi động lại | Nhiều máy chủ cùng lúc (không có bản sao máy chủ) |
| Mất ack, thao tác gửi lặp, thao tác đến sai thứ tự | Máy khách cố ý gửi dữ liệu sai nhưng đúng định dạng ngoài các kiểm tra ở mục 8 |
| Máy khách im lặng (không gửi heartbeat) | |

### 7.2. Cơ chế

| Cơ chế | Vị trí | Giá trị mặc định |
|---|---|---|
| Ack cho mỗi lô thao tác | Máy chủ gửi sau khi ghi SQLite | |
| Timeout chờ ack | `SyncClient` | 3 giây |
| Gửi lại có giới hạn | `SyncClient` | Tối đa 3 lần, sau đó kết nối lại |
| Loại bỏ thao tác trùng | `TextDoc.apply`, khóa `UNIQUE(doc_id, client, seq)` trong SQLite | |
| Bộ đệm cho thao tác sai thứ tự | `TextDoc.pending` | Máy chủ giới hạn 2000 thao tác |
| Heartbeat của máy khách | `SyncClient` gửi `ping` | Mỗi 4 giây. Không nghe gì trong 12 giây thì kết nối lại. |
| Heartbeat ở máy chủ | Máy chủ kiểm tra mỗi giây | Im lặng 15 giây thì máy chủ đóng kết nối và cập nhật `presence` |
| Kết nối lại | `SyncClient` | Backoff 250 ms, 500 ms, 1 s... tối đa 8 s, có jitter |
| Đồng bộ lại | `join` gửi state vector. Máy chủ trả thao tác còn thiếu. Máy khách gửi lại outbox. | |
| Lưu bền | Bảng `ops` (nhật ký thao tác, chỉ thêm), SQLite WAL, ghi trong transaction trước ack | |
| Phục hồi máy chủ | Room đọc lại bảng `ops` và tích hợp lại khi tài liệu được mở | |

Ngữ nghĩa gửi: at-least-once kết hợp loại bỏ trùng. Máy khách gửi lại đến khi có ack. Máy chủ chỉ áp dụng mỗi thao tác một lần.

Thời gian đo được: máy chủ phát hiện máy khách im lặng sau khoảng 1,9 giây khi `HEARTBEAT_TIMEOUT_MS=1000` (test `[R5]`).

## 8. Bảo mật

| Yêu cầu | Cách thực hiện |
|---|---|
| Xác thực người dùng | Đăng nhập bằng mật khẩu. Máy chủ trả token HMAC-SHA256 có hạn 12 giờ. |
| Không lưu mật khẩu dạng rõ | Máy chủ lưu hash argon2id (`Bun.password`). |
| Phân quyền | Bảng `members`: `owner`, `editor`, `viewer`. Người không phải thành viên không mở được tài liệu. `viewer` không gửi được thao tác. Chỉ `owner` chia sẻ được tài liệu. |
| Chống giả danh | Client ID phải bắt đầu bằng tên người dùng trong token. Mọi thao tác trong lô phải có `client` bằng Client ID của kết nối. |
| Kiểm tra đầu vào | `protocol.ts` kiểm tra kiểu, regex, độ dài của mọi trường. Máy chủ dùng câu lệnh SQL có tham số. Mã tài liệu chỉ có `[a-z0-9]`. |
| Giới hạn kích thước | 256 KB mỗi thông điệp, 1000 thao tác mỗi lô, 200 000 ký tự mỗi tài liệu, 2000 thao tác trong bộ đệm. |
| Khóa bí mật | `TOKEN_SECRET` nằm trong `.env`. Tệp `.env` có trong `.gitignore`. Ở chế độ production, máy chủ không chạy nếu thiếu `TOKEN_SECRET`. |
| Nhật ký | Máy chủ ghi đăng ký, đăng nhập sai, từ chối WebSocket, lỗi quyền, lỗi định dạng. Máy chủ không ghi mật khẩu và token. |
| TLS | Dùng Caddy trong `deploy/docker-compose.yml` (profile `tls`) để có HTTPS và WSS. |

> CẢNH BÁO: Không commit tệp `.env`. Tệp này chứa `TOKEN_SECRET`. Người có `TOKEN_SECRET` tạo được token của bất kỳ người dùng nào.

## 9. Yêu cầu môi trường

| Phần mềm | Phiên bản | Bắt buộc |
|---|---|---|
| Bun | 1.3.6 trở lên | Có |
| Trình duyệt | Chrome, Edge, Firefox, Safari bản mới | Có, cho giao diện web |
| Docker + Docker Compose | Docker 24 trở lên | Không, chỉ cho mục 15 |
| Hệ điều hành | macOS, Linux, Windows 10/11 | Có |

> GHI CHÚ: Trên Windows, chạy các tệp `scripts/*.sh` trong Git Bash hoặc WSL. Các lệnh `bun ...` chạy được trong PowerShell.

## 10. Cài đặt

1. Cài Bun.
   - macOS, Linux: `curl -fsSL https://bun.sh/install | bash`
   - Windows (PowerShell): `powershell -c "irm bun.sh/install.ps1 | iex"`
2. Kiểm tra phiên bản Bun. Kết quả phải là 1.3.6 hoặc lớn hơn.
   ```bash
   bun --version
   ```
3. Tải mã nguồn và vào thư mục dự án.
   ```bash
   git clone <URL kho GitHub của nhóm> ds04-collab-docs
   cd ds04-collab-docs
   ```
4. Cài các gói phát triển.
   ```bash
   bun install
   ```
5. Tạo tệp cấu hình.
   ```bash
   cp .env.example .env
   ```
6. Tạo một khóa bí mật. Ghi kết quả vào dòng `TOKEN_SECRET=` trong `.env`.
   ```bash
   openssl rand -hex 32
   ```
7. Ghi một mật khẩu demo vào dòng `DEMO_PASSWORD=` trong `.env`. Mật khẩu phải có 8 ký tự trở lên.

> GHI CHÚ: Nếu `TOKEN_SECRET` trống, máy chủ dùng một khóa ngẫu nhiên. Khi máy chủ khởi động lại, mọi token cũ không còn hợp lệ. Người dùng phải đăng nhập lại.

## 11. Chạy hệ thống

### 11.1. Chạy máy chủ

1. Chạy máy chủ.
   ```bash
   sh scripts/start-server.sh
   ```
2. Kiểm tra dòng `SERVER_START` trong nhật ký. Máy chủ nghe ở cổng 3000.
3. Tạo tài khoản demo và một tài liệu chung. Ghi lại mã tài liệu mà lệnh in ra.
   ```bash
   bun scripts/seed.ts
   ```
   Lệnh tạo 4 tài khoản: `alice` (chủ sở hữu), `bob` và `carol` (biên tập), `dave` (chỉ xem).

### 11.2. Chạy máy khách trên trình duyệt

1. Mở `http://localhost:3000` trong trình duyệt.
2. Đăng nhập bằng `alice` và mật khẩu demo.
3. Mở tài liệu "Tài liệu demo DS04".
4. Mở tab thứ hai. Đăng nhập bằng `bob`. Mở cùng tài liệu.
5. Mở tab thứ ba. Đăng nhập bằng `carol`. Mở cùng tài liệu.

> GHI CHÚ: Mỗi tab lưu phiên đăng nhập riêng (`sessionStorage`). Vì vậy 3 tab trong một trình duyệt là 3 người dùng khác nhau.

### 11.3. Chạy máy khách CLI

1. Mở một cửa sổ terminal mới.
2. Chạy lệnh sau. Thay `<mã tài liệu>` và `<mật khẩu>`.
   ```bash
   bun src/client/cli.ts --user bob --password <mật khẩu> --doc <mã tài liệu>
   ```
3. Gõ `help` để xem danh sách lệnh.

| Lệnh CLI | Tác dụng |
|---|---|
| `show` | In nội dung tài liệu và phiên bản |
| `ins <vị trí> <văn bản>` | Chèn văn bản. `\n` là xuống dòng. |
| `app <văn bản>` | Chèn văn bản vào cuối tài liệu |
| `del <vị trí> <số ký tự>` | Xóa văn bản |
| `offline` | Ngắt kết nối và giữ trạng thái ngắt. Thao tác mới chờ trong outbox. |
| `online` | Kết nối lại |
| `break` | Mô phỏng lỗi mạng. Máy khách tự kết nối lại. |
| `users` | In danh sách người đang mở |
| `status` | In trạng thái kết nối, phiên bản, số thao tác chưa lưu |
| `quit` | Thoát |

### 11.4. Chạy trên nhiều máy

- Mạng LAN: chạy máy chủ trên một máy. Trên các máy khác, mở `http://<IP máy chủ>:3000`. Với CLI, thêm `--server http://<IP máy chủ>:3000`.
- Internet: chạy máy chủ trên một máy chủ đám mây có IP công khai (mục 15). Mở cổng 3000, hoặc dùng Caddy với tên miền.

> CHÚ Ý: Không mở cổng 3000 ra Internet khi `.env` không có `TOKEN_SECRET` riêng.

## 12. Kịch bản demo

Các bước sau thực hiện đủ kịch bản bắt buộc của mục 8.4 trong đề. Trước khi bắt đầu, làm mục 11.1 và mục 11.2.

| # | Kịch bản (mục 8.4) | Thao tác | Bằng chứng |
|---|---|---|---|
| 1 | Ba máy khách mở cùng tài liệu | Làm mục 11.2 | Ô "Người đang mở" có 3 người. Nhật ký máy chủ có 3 dòng `JOIN`. |
| 2 | Một máy khách sửa, các máy khách khác nhận | Alice gõ một câu | Bob và Carol thấy câu ngay. Nhật ký máy chủ có `OPS ... result=OK`. |
| 3 | Hai máy khách chèn cùng vị trí cùng lúc | Chạy `DEMO_PASSWORD=<mật khẩu> sh scripts/concurrent-cli.sh <mã tài liệu>` | 3 tiến trình CLI in cùng một chuỗi, ví dụ `"[carol][bob][alice]"`. |
| 4 | Một máy khách chèn, một máy khách xóa | Alice bôi đen và xóa một đoạn. Cùng lúc, Bob gõ vào giữa đoạn đó. | Chữ Bob gõ còn lại. Ba tab có cùng nội dung. |
| 5 | Hội tụ | So sánh 3 tab | Ô "Phiên bản cục bộ" bằng nhau. Ô "Số ký tự" bằng nhau. |
| 6 | Ngắt một máy khách | Carol bấm "Ngắt kết nối" | Tab Carol hiện "Mất kết nối". Alice và Bob thấy Carol rời đi. |
| 7 | Các máy khách còn lại tiếp tục sửa | Alice và Bob gõ tiếp. Carol cũng gõ (offline). | Tab Carol hiện "Chưa lưu: N thao tác". |
| 8 | Máy khách kết nối lại và đồng bộ | Carol bấm "Kết nối lại" | Tab Carol hiện "Đã lưu trên máy chủ". Ba tab có cùng nội dung, gồm cả chữ Carol gõ khi offline. |
| 9 | Khởi động lại máy chủ và phục hồi tài liệu | Chạy `sh scripts/kill-server.sh`. Gõ thêm ở một tab. Chạy lại `sh scripts/start-server.sh`. | Nhật ký máy chủ có `ROOM_LOAD doc=... ops=N`. Các tab tự kết nối lại. Nội dung không mất. |

> GHI CHÚ: Ở bước 9, máy chủ dừng bằng SIGKILL. Máy chủ không chạy đoạn mã tắt máy. Đây là lỗi dừng đột ngột thật.

Kịch bản bổ sung về bảo mật: đăng nhập bằng `dave` (chỉ xem). Ô soạn thảo không cho gõ. Với CLI, lệnh `ins` của `dave` báo `read-only: viewers cannot edit`.

## 13. Kiểm thử

Chạy toàn bộ kiểm thử:

```bash
bun test
```

Kiểm tra kiểu TypeScript:

```bash
bun run typecheck
```

Mỗi kiểm thử tích hợp chạy máy chủ thật trong một tiến trình riêng, với một tệp SQLite riêng. Kết quả lần chạy gần nhất: 34 kiểm thử đạt, 0 lỗi, khoảng 4,4 giây.

| Loại (mục 9 của đề) | Số lượng | Mã kiểm thử |
|---|---|---|
| Chức năng (yêu cầu 8) | 9 | F1-F9 |
| Đồng thời, xung đột (yêu cầu 2) | 3 tích hợp + 3 đơn vị | C1-C3, U3-U5 |
| Lỗi và phục hồi (yêu cầu 2) | 6 tích hợp + 2 đơn vị | R1, R1b, R2-R5, U6-U7 |
| Bảo mật, dữ liệu sai (yêu cầu 2) | 5 | S1-S5 |
| Hiệu năng (yêu cầu 1) | 1 kiểm thử + 1 thí nghiệm | P1, `scripts/bench.ts` |
| Đơn vị CRDT khác | 4 | U1, U2, U8-U10 |

| Mã | Tệp | Nội dung |
|---|---|---|
| U1-U10 | `tests/crdt.test.ts` | CRDT cục bộ, chèn cùng vị trí, chèn trong khoảng xóa, xóa trùng, thao tác trùng, thao tác sai thứ tự, state vector, con trỏ, 300 lần thử ngẫu nhiên |
| F1 | `tests/server.test.ts` | Đăng ký, đăng nhập. Từ chối sai mật khẩu, tên trùng, tên sai định dạng. |
| F2 | `tests/server.test.ts` | Tạo, liệt kê, đọc thông tin tài liệu |
| F3 | `tests/server.test.ts` | Chủ sở hữu chia sẻ. Người khác không chia sẻ được. |
| F4 | `tests/sync.test.ts` | Ba máy khách mở cùng tài liệu và thấy nhau |
| F5 | `tests/sync.test.ts` | Chèn ở một máy khách, hai máy khách kia nhận |
| F6 | `tests/sync.test.ts` | Xóa ở một máy khách, hai máy khách kia nhận |
| F7 | `tests/sync.test.ts` | Máy khách vào sau nhận đủ nội dung |
| F8 | `tests/server.test.ts` | Lưu tài liệu: export đúng, SQLite có nội dung và nhật ký thao tác |
| F9 | `tests/sync.test.ts` | Danh sách người đang mở cập nhật khi một người rời đi |
| C1 | `tests/sync.test.ts` | Hai máy khách chèn cùng vị trí cùng lúc |
| C2 | `tests/sync.test.ts` | Một máy khách chèn trong khoảng máy khách khác xóa |
| C3 | `tests/sync.test.ts` | 3 máy khách, mỗi máy 100 thao tác ngẫu nhiên đồng thời |
| R1 | `tests/sync.test.ts` | Máy khách offline vẫn sửa, các máy khác sửa tiếp, kết nối lại thì hội tụ |
| R1b | `tests/sync.test.ts` | Mất kết nối khi một lô đang gửi. Máy khách tự kết nối lại và gửi lại. |
| R2 | `tests/server.test.ts` | Máy chủ dừng bằng SIGKILL, khởi động lại. Tài liệu được phục hồi. Máy khách hội tụ. |
| R3 | `tests/server.test.ts` | Một lô đến hai lần. Máy chủ chỉ áp dụng một lần. |
| R4 | `tests/server.test.ts` | Thao tác đến sai thứ tự. Máy chủ giữ trong bộ đệm. |
| R5 | `tests/server.test.ts` | Máy khách im lặng. Máy chủ phát hiện qua heartbeat. |
| S1 | `tests/server.test.ts` | WebSocket và API không có token hợp lệ bị từ chối (401) |
| S2 | `tests/server.test.ts` | Người ngoài không mở được tài liệu. `viewer` không sửa được. |
| S3 | `tests/server.test.ts` | Không dùng được Client ID của người khác |
| S4 | `tests/server.test.ts` | JSON sai, thao tác sai, thông điệp quá lớn bị từ chối. Kết nối vẫn dùng được. |
| S5 | `tests/server.test.ts` | Mật khẩu lưu dạng argon2id |
| P1 | `tests/sync.test.ts` | 10 máy khách x 30 thao tác. p95 độ trễ dưới 500 ms. |

Xem nhật ký máy chủ trong khi chạy kiểm thử:

```bash
SHOW_SERVER_LOG=1 bun test
```

## 14. Đánh giá hiệu năng

Chạy thí nghiệm:

```bash
bun scripts/bench.ts --clients 5,10,20,50 --ops 100 --interval 10
```

Script khởi động một máy chủ riêng. Mỗi máy khách chèn 1 ký tự mỗi 10 ms tại vị trí ngẫu nhiên. Script ghi kết quả vào `docs/benchmark.md`.

Kết quả trên MacBook (Apple Silicon, macOS, Bun 1.3.6), máy chủ và máy khách cùng một máy:

| Số máy khách | Tổng thao tác | Thông lượng (thao tác/s) | Độ trễ p50 (ms) | p95 (ms) | p99 (ms) | Ack RTT p95 (ms) | RAM máy chủ (MB) |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 5 | 500 | 430 | 1,2 | 3,1 | 5,6 | 2,6 | 52 |
| 10 | 1000 | 855 | 1,3 | 4,0 | 8,6 | 3,0 | 55 |
| 20 | 2000 | 1729 | 1,8 | 6,2 | 7,8 | 3,0 | 59 |
| 50 | 5000 | 4334 | 1,7 | 6,9 | 10,1 | 5,8 | 87 |

Độ trễ là thời gian từ lúc một máy khách tạo thao tác đến lúc máy khách khác tích hợp thao tác đó.
Thông lượng tăng theo số máy khách vì tải đầu vào tăng. Ở 50 máy khách, máy chủ chưa bão hòa.
Các số liệu này đo trên localhost. Trên LAN hoặc Internet, độ trễ cộng thêm thời gian mạng.

## 15. Triển khai lại bằng Docker

1. Làm bước 5 đến bước 7 của mục 10 (tạo `.env`).
2. Xây dựng image và chạy máy chủ.
   ```bash
   docker compose -f deploy/docker-compose.yml up -d --build
   ```
3. Mở `http://<IP máy chủ>:3000`.
4. Xem nhật ký.
   ```bash
   docker compose -f deploy/docker-compose.yml logs -f server
   ```
5. Dừng hệ thống.
   ```bash
   docker compose -f deploy/docker-compose.yml down
   ```

Dữ liệu nằm trong volume `ds04-data`. Lệnh `down` không xóa volume.

Chạy với HTTPS và WSS (cần một tên miền trỏ đến máy chủ):

```bash
DOMAIN=docs.example.com docker compose -f deploy/docker-compose.yml --profile tls up -d --build
```

Dừng đột ngột container máy chủ (kịch bản 9 khi dùng Docker):

```bash
sh scripts/kill-server.sh docker
docker compose -f deploy/docker-compose.yml start server
```

> CẢNH BÁO: Lệnh `docker compose down -v` xóa volume `ds04-data`. Lệnh này xóa mọi tài khoản và tài liệu.

## 16. Phân công công việc

| Thành viên | Phần việc | Tệp phụ trách | Kiểm thử phụ trách | Phần demo |
|---|---|---|---|---|
| Nguyễn Tất Khôi Nguyên (B23DCVT315) | Máy chủ: API HTTP, WebSocket, room, heartbeat | `src/server/main.ts`, `src/server/room.ts`, `src/server/config.ts` | F1, F2, F3, F8, R2, R3, R4, R5 | Kịch bản 1, 9 |
| | Lưu trữ và phục hồi: SQLite, nhật ký thao tác | `src/server/store.ts` | | |
| | Bảo mật: mật khẩu, token, phân quyền, kiểm tra đầu vào | `src/server/auth.ts`, `src/shared/protocol.ts`, `src/shared/log.ts` | S1, S2, S3, S4, S5 | Kịch bản bảo mật |
| | Triển khai, script vận hành, đo hiệu năng | `deploy/`, `scripts/start-server.sh`, `scripts/kill-server.sh`, `scripts/seed.ts`, `scripts/bench.ts`, `tests/helpers.ts`, `tests/server.test.ts` | P1 (cùng Phúc) | Mục 14 |
| Nguyễn Duy Phúc (B23DCVT341) | CRDT RGA, đồng hồ Lamport, state vector | `src/shared/crdt.ts` | U1-U10 | Giải thích mục 6 |
| | Máy khách đồng bộ: outbox, ack, retry, heartbeat, kết nối lại, offline | `src/client/sync-client.ts` | R1, R1b | Kịch bản 6, 7, 8 |
| | Giao diện web: trình soạn thảo, con trỏ người khác, người đang mở, nhật ký | `src/client/web/` | F4, F5, F6, F7, F9 | Kịch bản 2, 4, 5 |
| | CLI và demo đồng thời | `src/client/cli.ts`, `scripts/concurrent-cli.sh`, `tests/sync.test.ts` | C1, C2, C3, P1 | Kịch bản 3 |
| Cả hai | README, báo cáo, slide, buổi demo | `README.md`, `docs/` | | Giới thiệu kiến trúc |

### 16.1. Quy tắc commit

Đề yêu cầu lịch sử commit của từng thành viên. Mỗi thành viên commit phần của mình từ tài khoản GitHub của mình.

1. Chủ kho GitHub thêm Khôi Nguyên và Phúc làm collaborator.
2. Mỗi thành viên đặt tên và email Git của mình.
   ```bash
   git config user.name "<Họ tên>"
   git config user.email "<email GitHub>"
   ```
3. Mỗi thành viên chỉ `git add` các tệp trong cột "Tệp phụ trách" của mình.
4. Mỗi thành viên viết commit message theo dạng `<loại>(<phạm vi>): <nội dung>`. Ví dụ: `feat(crdt): add RGA insert and delete`.
5. Khi xong, tạo tag `v1.0.0`.
   ```bash
   git tag v1.0.0
   git push origin main --tags
   ```
6. Nếu kho là private, thêm giảng viên làm collaborator.

## 17. Cấu trúc thư mục

```
.
├── README.md
├── .env.example            mẫu cấu hình, không có giá trị bí mật
├── package.json, tsconfig.json, bun.lock
├── src/
│   ├── shared/             mã dùng chung cho máy chủ và máy khách
│   │   ├── crdt.ts         CRDT RGA
│   │   ├── protocol.ts     định dạng thông điệp và kiểm tra đầu vào
│   │   └── log.ts          định dạng nhật ký
│   ├── server/             máy chủ cộng tác
│   │   ├── main.ts         API HTTP, WebSocket, heartbeat
│   │   ├── room.ts         một tài liệu đang mở
│   │   ├── store.ts        SQLite
│   │   ├── auth.ts         mật khẩu và token
│   │   └── config.ts       biến môi trường
│   └── client/
│       ├── sync-client.ts  đồng bộ (dùng cho web, CLI, kiểm thử)
│       ├── cli.ts          máy khách dòng lệnh
│       └── web/            giao diện web (index.html, app.ts, style.css)
├── tests/                  crdt.test.ts, sync.test.ts, server.test.ts, helpers.ts
├── scripts/                start-server.sh, kill-server.sh, seed.ts, concurrent-cli.sh, bench.ts
├── deploy/                 Dockerfile, docker-compose.yml
└── docs/                   benchmark.md (kết quả đo)
```

## 18. Giới hạn

- Máy chủ là điểm lỗi đơn. Khi máy chủ dừng, máy khách vẫn sửa được nhưng không thấy thao tác của nhau. Hướng phát triển: chạy nhiều máy chủ và sao chép bảng `ops` giữa các máy chủ.
- CRDT giữ mọi tombstone. Tài liệu bị sửa nhiều thì dùng nhiều bộ nhớ hơn số ký tự hiện có.
- Mỗi ký tự là một thao tác. Dán một đoạn văn dài tạo nhiều thao tác. Máy khách chia thao tác thành lô 500.
- Tìm vị trí trong CRDT có độ phức tạp O(n). Mức này đủ cho tài liệu dưới 200 000 ký tự.
- Máy khách mới nhận toàn bộ nhật ký thao tác khi mở tài liệu. Hướng phát triển: gửi snapshot kèm phần nhật ký sau snapshot.
- Thao tác offline nằm trong bộ nhớ của tab. Nếu người dùng đóng tab khi offline, các thao tác chưa lưu bị mất.
- Token nằm trong query string của URL WebSocket. Dùng HTTPS/WSS để token không đi qua mạng dạng rõ.

## 19. Tài liệu tham khảo

1. H.-G. Roh, M. Jeon, J.-S. Kim, J. Lee. "Replicated abstract data types: Building blocks for collaborative applications". Journal of Parallel and Distributed Computing, 71(3), 2011.
2. M. Shapiro, N. Preguiça, C. Baquero, M. Zawirski. "Conflict-free Replicated Data Types". SSS 2011, LNCS 6976.
3. L. Lamport. "Time, Clocks, and the Ordering of Events in a Distributed System". Communications of the ACM, 21(7), 1978.
4. M. Kleppmann. "Designing Data-Intensive Applications". O'Reilly, 2017. Chương 5 và chương 9.
5. Tài liệu Bun: https://bun.sh/docs (HTTP server, WebSocket, SQLite, `Bun.password`).
6. RFC 6455: The WebSocket Protocol.
7. RFC 2104: HMAC: Keyed-Hashing for Message Authentication.
