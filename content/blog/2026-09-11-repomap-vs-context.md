---
title: "Repo map: kenapa Minicode membaca peta kode dulu sebelum detailnya"
date: 2026-09-11
tags: [ai, llm, coding-agent]
desc: "Repo map Minicode memberi LLM peta simbol kode sebelum membaca detail: hemat token, lebih murah, dan model lebih fokus. Pola yang bisa Anda tiru."
---

Model dengan ruang konteks sangat besar menggoda kita untuk mengirim seluruh kode ke dalam prompt. Tapi ada tiga masalah utama: biaya yang tidak perlu, waktu tunggu yang lebih lama, dan banyaknya informasi yang justru menyulitkan model fokus.

## Peta dulu, baca kemudian

Minicode tidak mengirim seluruh kode sekaligus. Ia membangun repo map: peta ringkas simbol-simbol penting dalam kode Anda — fungsi, class, dan nama-nama utama — lalu menyampaikannya kepada model sebelum mulai bekerja.

Ringkasan ini disimpan dalam file sementara sehingga tidak perlu dibuat berulang kali. File tersebut diperbarui hanya jika kode Anda berubah.

## Kenapa tidak memakai alat analisis kode yang rumit

Ada alat yang bisa membaca struktur kode secara mendalam, tapi Minicode tidak menggunakannya. Alasannya sederhana: alat semacam itu memerlukan perangkat lunak tambahan untuk setiap bahasa pemrograman, dan informasi yang dihasilkannya seringkali terlalu detail untuk tujuan orientasi awal.

Untuk tahap awal, cukup tahu nama-nama simbol penting dan di mana mereka berada. Setelah itu, jika memang perlu, model dapat membaca bagian kode yang lebih spesifik.

## Jika ringkasan tidak cukup, lanjut ke langkah berikutnya

Jika ringkasan ringkas tidak cukup, Minicode dapat menggunakan alat yang lebih spesifik untuk mencari informasi. Barulah setelah itu, model membaca isi file secara langsung jika benar-benar diperlukan.

Pola ini membantu menghemat biaya dan waktu, sekaligus membuat model lebih mudah fokus pada yang penting. Anda juga bisa menerapkan pola serupa pada agent lain yang Anda gunakan: mulai dari gambaran umum yang murah, baru kemudian membaca detailnya.

Baca lebih lanjut: [Arsitektur Minicode](/docs/architecture.html) menjelaskan alur peta-dulu-diikuti-baca, dan [referensi Tools](/docs/tools.html) memuat tool repo map yang dipakai di artikel ini.
