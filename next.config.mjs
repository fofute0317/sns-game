/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false, // 既存のバニラJSコントローラを二重起動させないため
  async redirects() {
    return [
      // 旧URL（Nodeサーバ時代のパス）からの互換リダイレクト。
      // 教室で配られた古いURL・ブックマークを壊さないために残します。
      { source: '/teacher.html', destination: '/teacher', permanent: false },
      { source: '/play.html', destination: '/play', permanent: false },
    ];
  },
};

export default nextConfig;
