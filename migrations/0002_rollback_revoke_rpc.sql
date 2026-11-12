-- 0002 되돌리기: 문의 게시판 RPC 실행 권한 복원 (원래 상태: public/anon/authenticated 실행 가능)
grant execute on function public._check_admin_pw(text) to public, anon, authenticated;
grant execute on function public.change_admin_pw(text, text) to public, anon, authenticated;
grant execute on function public.delete_inquiry(text, bigint) to public, anon, authenticated;
grant execute on function public.delete_inquiry_by_user(bigint, text) to public, anon, authenticated;
grant execute on function public.list_inquiries(text) to public, anon, authenticated;
grant execute on function public.list_inquiries_public() to public, anon, authenticated;
grant execute on function public.mark_inquiry_read(text, bigint, boolean) to public, anon, authenticated;
grant execute on function public.submit_inquiry(text, text, text, text) to public, anon, authenticated;
grant execute on function public.update_inquiry_by_user(bigint, text, text, text, text) to public, anon, authenticated;
grant execute on function public.verify_inquiry(bigint, text) to public, anon, authenticated;
