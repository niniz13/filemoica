import ShareDownload from "@/components/share-download";

export default async function Page(props: PageProps<"/d/[token]">) {
  const { token } = await props.params;
  return <ShareDownload token={token} />;
}
