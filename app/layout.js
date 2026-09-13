import "./globals.css";
import "katex/dist/katex.min.css";
import { Sora, Plus_Jakarta_Sans } from "next/font/google";
import { AuthProvider } from "@/context/AuthContext";
import { ThemeProvider } from "@/context/ThemeContext";

const display = Sora({
  subsets: ["latin"],
  weight: ["500", "600", "700", "800"],
  variable: "--font-display",
  display: "swap",
});
const body = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-body",
  display: "swap",
});

export const metadata = {
  title: "SlideBaba — AI Study Assistant",
  description:
    "Turn documents, question papers and handwritten notes into editable PPT slides and A4 study notes with AI-grade OCR.",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icon.png", type: "image/png", sizes: "256x256" },
    ],
    apple: [{ url: "/apple-icon.png", sizes: "180x180" }],
  },
  openGraph: {
    title: "SlideBaba — AI Study Assistant",
    description:
      "Turn documents, question papers and handwritten notes into editable PPT slides and A4 study notes.",
    images: ["/logo-512.png"],
  },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0b0a18",
};

// Runs before paint to set the theme class and avoid a flash of the wrong theme.
const themeScript = `(function(){try{var t=localStorage.getItem('slidebaba-theme');if(t!=='light'){document.documentElement.classList.add('dark');}else{document.documentElement.classList.remove('dark');}}catch(e){document.documentElement.classList.add('dark');}})();`;

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Lexend:wght@300;400;500;600;700&family=Poppins:wght@400;500;600;700&family=Roboto:wght@400;500;700&family=Montserrat:wght@400;500;600;700;800;900&family=Lato:wght@400;700&family=Open+Sans:wght@400;600;700&family=Nunito:wght@400;600;700&family=Raleway:wght@400;600;700&family=Work+Sans:wght@400;600;700&family=DM+Sans:wght@400;500;700&family=Space+Grotesk:wght@400;500;700&family=Merriweather:wght@400;700&family=Playfair+Display:wght@400;600;700&family=Lora:wght@400;600&family=PT+Serif:wght@400;700&family=Oswald:wght@400;600&family=Bebas+Neue&family=Source+Sans+3:wght@400;600;700&family=Quicksand:wght@400;600&family=Comfortaa:wght@400;600&family=Caveat:wght@400;700&family=Roboto+Mono:wght@400;500&display=swap"
        />
      </head>
      <body className="font-sans antialiased selection:bg-brand-500/30">
        <ThemeProvider>
          <AuthProvider>{children}</AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
