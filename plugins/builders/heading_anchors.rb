class Builders::HeadingAnchors < SiteBuilder
  def build
    hook :posts, :post_render do |post|
      post.output = post.output.gsub(%r{<(h[23]) id="([^"]+)">(.*?)</\1>}, '<\1 id="\2"><a href="#\2">\3</a></\1>')
    end
  end
end
